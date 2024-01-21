"use strict";

window.addEventListener("DOMContentLoaded", () => {
	const elements = (() => {
		const es = {};
		const sel = document.querySelectorAll("*");
		sel.forEach((e) => {
			if (e.id) es[e.id] = e;
		});
		return es;
	})();

	// 繰り返し回数無限にチェックが入っているときは、繰り返し回数の数値入力を無効にする
	const setRepeatNumEnabled = () => {
		elements.repeatNum.disabled = elements.repeatInf.checked;
	};
	elements.repeatInf.addEventListener("change", setRepeatNumEnabled);
	setRepeatNumEnabled();

	// Uint8Array を文字列に変換する
	const readString = (array) => {
		return array.reduce((acc, cur) => acc + String.fromCharCode(cur), "");
	};
	// Uint8Array をリトルエンディアンとして符号なし数値に変換する
	const readInt = (array) => {
		return array.reduceRight((acc, cur) => acc * 256 + cur);
	};
	// 文字列を Uint8Array に変換する
	const stringToBytes = (str) => {
		const result = new Uint8Array(str.length);
		for (let i = 0; i < str.length; i++) result[i] = str.charCodeAt(i);
		return result;
	};
	// 符号なし数値をリトルエンディアンで Uint8Array に変換する
	const intToBytes = (value, size) => {
		const result = new Uint8Array(size);
		let acc = value;
		for (let i = 0; i < result.length; i++) {
			result[i] = acc;
			acc = Math.floor(acc / 256);
		}
		return result;
	};
	// 配列で与えられた Uint8Array のデータを結合し、新しい Uint8Array を返す
	const concatUint8Arrays = (arrayOfUint8Arrays) => {
		const resultSize = arrayOfUint8Arrays.reduce((acc, cur) => acc + cur.length, 0);
		const resultArray = new Uint8Array(resultSize);
		let resultPtr = 0;
		arrayOfUint8Arrays.forEach((array) => {
			resultArray.set(array, resultPtr);
			resultPtr += array.length;
		});
		return resultArray;
	};
	// チャンク名 (FourCC 文字列) とデータ (Uint8Array) からチャンク (Uint8Array) を生成する
	const data2chunk = (name, data) => {
		const result = new Uint8Array(8 + data.length + data.length % 2); // パディングを考慮
		for (let i = 0; i < 4; i++) {
			result[i] = i < name.length ? name.charCodeAt(i) : 0x20;
		}
		result.set(intToBytes(data.length, 4), 4);
		result.set(data, 8);
		return result;
	}
	// 画像データオブジェクトを WebP 形式の画像 (Uint8Array) に変換する
	const imageData2Bytes = (imageData) => {
		// 透明度情報 (ALPHチャンクまたはVP8Lチャンク) があるかを判定する
		let hasAlpha = false;
		for (let i = 0; i < imageData.imageDataChunks.length && !hasAlpha; i++) {
			const chunkName = readString(imageData.imageDataChunks[i].subarray(0, 4));
			if (chunkName === "ALPH" || chunkName === "VP8L") {
				hasAlpha = true;
			} else if (chunkName === "ANMF") {
				const subChunkName1 = readString(imageData.imageDataChunks[i].subarray(24, 28));
				if (subChunkName1 === "ALPH" || subChunkName1 === "VP8L") {
					hasAlpha = true;
				}
			}
		}
		// VP8Xチャンクのデータを構築する
		const vp8xData = new Uint8Array(10); // データは0で初期化される
		if (imageData.iccpChunk) vp8xData[0] |= 0x20;
		if (hasAlpha) vp8xData[0] |= 0x10;
		if (imageData.exifChunk) vp8xData[0] |= 0x08;
		if (imageData.xmpChunk) vp8xData[0] |= 0x04;
		if (imageData.animChunk) vp8xData[0] |= 0x02;
		vp8xData.set(imageData.dimension, 4);
		// 各チャンクのデータを結合用に配列に入れる
		const chunkDataArray = [];
		chunkDataArray.push(new Uint8Array([0x57, 0x45, 0x42, 0x50])); // "WEBP" (ファイルヘッダの一部だが、簡単のためここに含める)
		chunkDataArray.push(data2chunk("VP8X", vp8xData));
		if (imageData.iccpChunk) chunkDataArray.push(imageData.iccpChunk);
		if (imageData.animChunk) chunkDataArray.push(imageData.animChunk);
		imageData.imageDataChunks.forEach((chunk) => chunkDataArray.push(chunk));
		if (imageData.exifChunk) chunkDataArray.push(imageData.exifChunk);
		if (imageData.xmpChunk) chunkDataArray.push(imageData.xmpChunk);
		imageData.unknownChunks.forEach((chunk) => chunkDataArray.push(chunk));
		if (imageData.headerUnknown) chunkDataArray.push(data2chunk("head", imageData.headerUnknown));
		// 各チャンクのデータを結合する
		const chunkData = concatUint8Arrays(chunkDataArray);
		const finalImageData = data2chunk("RIFF", chunkData);
		return finalImageData;
	};

	// Uint8Array のデータの CRC32 を求める
	const crc32Magic = 0xEDB88320;
	const crc32Table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let value = i;
		for (let j = 0; j < 8; j++) {
			let lsb = value & 1;
			value = ((value >>> 1) ^ (lsb ? crc32Magic : 0)) >>> 0;
		}
		crc32Table[i] = value;
	}
	const calcCrc32 = (array) => {
		return (~array.reduce((acc, cur) => (crc32Table[(acc ^ cur) & 0xFF] ^ (acc >>> 8)) >>> 0, 0xFFFFFFFF)) >>> 0;
	};

	// 画像抽出処理本体
	const chunkIDsToSearch = ["VP8 ", "VP8L", "ICCP", "ALPH", "ANIM"];
	const PHASE_FIRST = 0, PHASE_ICCP = 1, PHASE_ANIM = 2, PHASE_ALPH = 3;
	const PHASE_VP = 4, PHASE_ANMF = 5, PHASE_EXIF = 6, PHASE_XMP = 7, PHASE_UNKNOWN = 8;
	const chunkNames = {
		[PHASE_ICCP]: "ICCP", [PHASE_ANIM]: "ANIM", [PHASE_ALPH]: "ALPH",
		[PHASE_VP]: "VP8/VP8L", [PHASE_ANMF]: "ANMF", [PHASE_EXIF]: "EXIF", [PHASE_XMP]: "XMP",
		[PHASE_UNKNOWN]: "未知",
	};
	const prevBlobURLs = [];
	let processing = false;
	const doExtractImages = (file) => {
		if (processing) return;
		processing = true;
		// 前の処理結果を片付ける
		elements.resultArea.style.display = "none";
		while (elements.previewArea.firstChild) {
			elements.previewArea.removeChild(elements.previewArea.firstChild);
		}
		while (elements.warningsArea.firstChild) {
			elements.warningsArea.removeChild(elements.warningsArea.firstChild);
		}
		prevBlobURLs.forEach((e) => URL.revokeObjectURL(e));
		prevBlobURLs.splice(0);

		// 今回のファイルを処理する
		file.arrayBuffer().then((fileDataBuffer) => {
			const fileData = new Uint8Array(fileDataBuffer);
			const warnings = [];
			// 最初のWebPチャンクを探す
			let firstChunkPos = -1;
			for (let i = 0; i < fileData.length; i++) {
				const chunkCandidate = readString(fileData.subarray(i, i + 4));
				if (chunkIDsToSearch.indexOf(chunkCandidate) >= 0) {
					firstChunkPos = i;
					break;
				}
			}
			if (firstChunkPos < 0) {
				alert("WebPチャンクが見つかりません。");
				return;
			}
			// 最初のデータ (A3 20/10 …) の位置を求める
			let currentPos = firstChunkPos - 0x12;
			if (currentPos >= 0 && fileData[currentPos] === 0x10) currentPos--;
			if (currentPos < 0 || fileData[currentPos] !== 0xA3 ||
			(fileData[currentPos + 1] !== 0x20 && fileData[currentPos + 1] !== 0x10)) {
				alert("最初のWebPチャンクの前に A3 20/10 から始まるデータが見つかりません。");
				return;
			}
			// データごとに分離する
			const rawImageDataArray = [];
			while (currentPos < fileData.length) {
				if (currentPos + 1 >= fileData.length) break;
				let currentDataSize, currentDataPos;
				if (fileData[currentPos + 1] == 0x20) {
					if (currentPos + 3 >= fileData.length) break;
					currentDataSize = (fileData[currentPos + 2] << 8) + fileData[currentPos + 3];
					currentDataPos = currentPos + 4;
				} else if (fileData[currentPos + 1] == 0x10) {
					if (currentPos + 4 >= fileData.length) break;
					currentDataSize = (fileData[currentPos + 2] << 16) + (fileData[currentPos + 3] << 8) + fileData[currentPos + 4];
					currentDataPos = currentPos + 5;
				} else {
					break;
				}
				if (currentDataPos + currentDataSize > fileData.length) {
					warnings.push("0x" + currentPos.toString(16) + " からのデータ中に予期せぬファイル終端が見つかりました。");
					currentDataSize = fileData.length - currentDataPos;
				}
				rawImageDataArray.push({
					startPos: currentPos,
					dataPos: currentDataPos,
					data: fileData.subarray(currentDataPos, currentDataPos + currentDataSize),
				});
				currentPos = currentDataPos + currentDataSize;
			}
			if (currentPos < fileData.length) {
				warnings.push("0x" + currentPos.toString(16) + " からの無効なデータを無視します。");
			}
			// それぞれのデータを幅・高さとチャンクに分解する
			const imageDataArray = [];
			rawImageDataArray.forEach((rawImageData) => {
				const startPos = rawImageData.startPos, dataPos = rawImageData.dataPos;
				const data = rawImageData.data;
				if (data.length < 0xE) {
					warnings.push("0x" + startPos.toString(16) + " からのデータは短すぎるので、無視します。");
					return;
				}
				const headerUnknown = data.subarray(0, 8);
				const dimension = data.subarray(8, 8 + 6);
				let chunkPtr = 0xE;
				let phase = PHASE_FIRST;
				let iccpChunk = null, animChunk = null, exifChunk = null, xmpChunk = null;
				const imageDataChunks = [], unknownChunks = [];
				let imageDataExists = false;
				while (chunkPtr < data.length) {
					const warningPrefix = "0x" + startPos.toString(16) + " 内、0x" + (dataPos + chunkPtr).toString(16) + " からの";
					if (chunkPtr + 8 > data.length) {
						warnings.push(warningPrefix + "データはチャンクとして短すぎるので、無視します。");
						break;
					}
					const chunkName = readString(data.subarray(chunkPtr, chunkPtr + 4));
					const chunkSizeRaw = readInt(data.subarray(chunkPtr + 4, chunkPtr + 8));
					const chunkSize = chunkSizeRaw + chunkSizeRaw % 2; // パディングを考慮
					if (chunkPtr + 8 + chunkSize > data.length) {
						warnings.push(warningPrefix + "データ中に予期せぬ終端があります。このデータを無視します。");
						break;
					}
					const chunkData = data.subarray(chunkPtr, chunkPtr + 8 + chunkSize);
					const invalidOrderMessage = warningPrefix + chunkName + "チャンクは" + chunkNames[phase] + "チャンクの後なので、無視します。";
					if (chunkName === "ICCP") {
						if (phase >= PHASE_ICCP) {
							warnings.push(invalidOrderMessage);
						} else {
							iccpChunk = chunkData;
							phase = PHASE_ICCP;
						}
					} else if (chunkName === "ANIM") {
						if (phase >= PHASE_ANIM) {
							warnings.push(invalidOrderMessage);
						} else {
							animChunk = chunkData;
							phase = PHASE_ANIM;
						}
					} else if (chunkName === "ALPH") {
						if (animChunk) {
							warnings.push(warningPrefix + chunkName + "チャンクはANIMチャンクが存在するので、無視します。");
						} else if (phase >= PHASE_ALPH) {
							warnings.push(invalidOrderMessage);
						} else {
							imageDataChunks.push(chunkData);
							phase = PHASE_ALPH;
						}
					} else if (chunkName === "VP8 " || chunkName === "VP8L") {
						if (animChunk) {
							warnings.push(warningPrefix + chunkName + "チャンクはANIMチャンクが存在するので、無視します。");
						} else if (phase >= PHASE_VP) {
							warnings.push(invalidOrderMessage);
						} else {
							imageDataChunks.push(chunkData);
							phase = PHASE_VP;
							imageDataExists = true;
						}
					} else if (chunkName === "ANMF") {
						if (!animChunk) {
							warnings.push(warningPrefix + chunkName + "チャンクはANIMチャンクが存在しないので、無視します。");
						} else if (phase > PHASE_ANMF) { // ANMFチャンクは複数存在してもよい
							warnings.push(invalidOrderMessage);
						} else {
							imageDataChunks.push(chunkData);
							phase = PHASE_ANMF;
							imageDataExists = true;
						}
					} else if (chunkName === "EXIF") {
						if (phase >= PHASE_EXIF) {
							warnings.push(invalidOrderMessage);
						} else {
							imageDataChunks.push(chunkData);
							phase = PHASE_EXIF;
						}
					} else if (chunkName === "XMP ") {
						if (phase >= PHASE_XMP) {
							warnings.push(invalidOrderMessage);
						} else {
							imageDataChunks.push(chunkData);
							phase = PHASE_XMP;
						}
					} else {
						unknownChunks.push(chunkData);
						phase = PHASE_UNKNOWN;
					}
					chunkPtr += 8 + chunkSize;
				}
				if (imageDataExists) {
					imageDataArray.push({
						startPos: startPos,
						headerUnknown: headerUnknown,
						dimension: dimension,
						iccpChunk: iccpChunk,
						animChunk: animChunk,
						imageDataChunks: imageDataChunks,
						exifChunk: exifChunk,
						xmpChunk: xmpChunk,
						unknownChunks: unknownChunks,
					});
				} else {
					warnings.push("0x" + startPos.toString(16) + " からのデータには画像データが見つからなかったので、無視します。");
				}
			});

			// 出力形式を決定する
			let outputWebpAnim = elements.webpRadio.checked;
			let webpRepeatNum, webpFirstFrameWait, webpOtherFrameWait, webpLastFrameWait;
			if (outputWebpAnim) {
				for (let i = 0; i < imageDataArray.length; i++) {
					if (imageDataArray[i].animChunk) {
						warnings.push("アニメーションにアニメーションは含められません。ZIPでの出力に切り替えます。");
						outputWebpAnim = false;
						break;
					}
				}
				if (elements.repeatInf.checked) {
					webpRepeatNum = 0;
				} else {
					webpRepeatNum = parseInt(elements.repeatNum.value, 10);
					if (isNaN(webpRepeatNum) || webpRepeatNum < 1 || 0xffff < webpRepeatNum) {
						warnings.push("繰り返し回数が不正です。ZIPでの出力に切り替えます。");
						outputWebpAnim = false;
					}
				}
				webpFirstFrameWait = parseInt(elements.firstFrameWait.value, 10);
				if (isNaN(webpFirstFrameWait) || webpFirstFrameWait < 0 || 0xffffff < webpFirstFrameWait) {
					warnings.push("最初のフレームの表示時間が不正です。ZIPでの出力に切り替えます。");
						outputWebpAnim = false;
				}
				webpOtherFrameWait = parseInt(elements.otherFrameWait.value, 10);
				if (isNaN(webpOtherFrameWait) || webpOtherFrameWait < 0 || 0xffffff < webpOtherFrameWait) {
					warnings.push("中間のフレームの表示時間が不正です。ZIPでの出力に切り替えます。");
						outputWebpAnim = false;
				}
				webpLastFrameWait = parseInt(elements.lastFrameWait.value, 10);
				if (isNaN(webpLastFrameWait) || webpLastFrameWait < 0 || 0xffffff < webpLastFrameWait) {
					warnings.push("最後のフレームの表示時間が不正です。ZIPでの出力に切り替えます。");
						outputWebpAnim = false;
				}
			}
			// 出力を構築する
			const previewImages = [];
			let downloadData, downloadName;
			if (outputWebpAnim) {
				// 各画像をフレームデータに変換する
				const frames = [];
				let maxWidth = 0, maxHeight = 0;
				let iccpChunk = null, exifChunk = null, xmpChunk = null;
				imageDataArray.forEach((imageData, idx) => {
					// 最大の幅と高さを採用し、メタデータは最初のものを用いる
					const width = readInt(imageData.dimension.subarray(0, 3));
					const height = readInt(imageData.dimension.subarray(3, 6));
					if (maxWidth < width) maxWidth = width;
					if (maxHeight < height) maxHeight = height;
					if (iccpChunk === null && imageData.iccpChunk) iccpChunk = imageData.iccpChunk;
					if (exifChunk === null && imageData.exifChunk) exifChunk = imageData.exifChunk;
					if (xmpChunk === null && imageData.xmpChunk) xmpChunk = imageData.xmpChunk;
					// フレームデータ (ANMFチャンク) を構築する
					const duration = idx === 0 ? webpFirstFrameWait : (idx === imageData.length - 1 ? webpLastFrameWait : webpOtherFrameWait);
					const anmfHeader = new Uint8Array(16); // 0で初期化される
					anmfHeader.set(imageData.dimension, 6);
					anmfHeader.set(intToBytes(duration, 3), 12);
					anmfHeader[15] = 0x02; // アルファブレンドなし、消去なし
					const anmfDataArray = [];
					anmfDataArray.push(anmfHeader);
					imageData.imageDataChunks.forEach((chunk) => anmfDataArray.push(chunk));
					imageData.unknownChunks.forEach((chunk) => anmfDataArray.push(chunk));
					if (imageData.headerUnknown) anmfDataArray.push(data2chunk("head", imageData.headerUnknown));
					if (imageData.iccpChunk) anmfDataArray.push(concatUint8Arrays([stringToBytes("iccp"), imageData.iccpChunk.subarray(4)]));
					if (imageData.exifChunk) anmfDataArray.push(concatUint8Arrays([stringToBytes("exif"), imageData.exifChunk.subarray(4)]));
					if (imageData.xmpChunk) anmfDataArray.push(concatUint8Arrays([stringToBytes("xmp "), imageData.xmpChunk.subarray(4)]));
					const anmfChunk = data2chunk("ANMF", concatUint8Arrays(anmfDataArray));
					frames.push(anmfChunk);
				});
				// ANIMチャンクのデータを構築する
				const animData = new Uint8Array(6); // 0で初期化される
				// 背景色 = (0, 0, 0, 0)
				animData.set(intToBytes(webpRepeatNum, 2), 4);
				// 画像の幅と高さの情報を構築する
				const imageDimension = new Uint8Array(6);
				imageDimension.set(intToBytes(maxWidth, 3), 0);
				imageDimension.set(intToBytes(maxHeight, 3), 3);
				// 画像データを構築する
				const imageData = {
					startPos: 0,
					headerUnknown: null,
					dimension: imageDimension,
					iccpChunk: iccpChunk,
					animChunk: data2chunk("ANIM", animData),
					imageDataChunks: frames,
					exifChunk: exifChunk,
					xmpChunk: xmpChunk,
					unknownChunks: [],
				};
				const webpData = imageData2Bytes(imageData);
				const webpBlob = new Blob([webpData], {type: "image/webp"});
				previewImages.push(webpBlob);
				downloadData = webpBlob;
				downloadName = file.name.replace(/((.)\.[^.]*)?$/, "$2.webp");
			} else {
				const currentDateRaw = new Date();
				// 符号付きにならないよう、25ビットシフトではなく24ビットシフトして2倍にする
				// さらに、ビットORではなく加算を用いる
				const dateTime = (((currentDateRaw.getFullYear() - 1980) << 24) * 2) +
					((currentDateRaw.getMonth() + 1) << 21) +
					(currentDateRaw.getDate() << 16) +
					(currentDateRaw.getHours() << 11) +
					(currentDateRaw.getMinutes() << 5) +
					(currentDateRaw.getSeconds() >> 1);
				const fileEntries = [];
				imageDataArray.forEach((imageData, idx) => {
					const webpData = imageData2Bytes(imageData);
					previewImages.push(new Blob([webpData], {type: "image/webp"}));
					const idxPadded = "00000" + idx.toString(10);
					fileEntries.push({
						data: webpData,
						crc32: calcCrc32(webpData),
						fileName: (idx < 100000 ? idxPadded.substring(idxPadded.length - 5) : idx.toString(10)) + ".webp",
					});
				});
				const localFileHeaders = [], centralDirectoryHeaders = [];
				let localFileHeaderPos = 0, centralDirectoryHeadersSize = 0;
				fileEntries.forEach((fileEntry) => {
					const localFileHeaderData = [
						new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // local file header signature
						intToBytes(10, 2), // version needed to extract
						intToBytes(0, 2), // general purpose bit flag
						intToBytes(0, 2), // compression method
						intToBytes(dateTime, 4), // last mod file time/date
						intToBytes(fileEntry.crc32, 4), // crc-32
						intToBytes(fileEntry.data.length, 4), // compressed size
						intToBytes(fileEntry.data.length, 4), // uncompressed size
						intToBytes(fileEntry.fileName.length, 2), // file name length
						intToBytes(0, 2), // extra field length
						stringToBytes(fileEntry.fileName), // file name
						// extra field
					];
					const localFileHeader = concatUint8Arrays(localFileHeaderData);
					localFileHeaders.push(localFileHeader);
					localFileHeaders.push(fileEntry.data);
					const centralDirectoryHeaderData = [
						new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // central directory signature
						intToBytes(63, 2), // version made by
						intToBytes(10, 2), // version needed to extract
						intToBytes(0, 2), // general purpose bit flag
						intToBytes(0, 2), // compression method
						intToBytes(dateTime, 4), // last mod file time/date
						intToBytes(fileEntry.crc32, 4), // crc-32
						intToBytes(fileEntry.data.length, 4), // compressed size
						intToBytes(fileEntry.data.length, 4), // uncompressed size
						intToBytes(fileEntry.fileName.length, 2), // file name length
						intToBytes(0, 2), // extra field length
						intToBytes(0, 2), // file comment length
						intToBytes(0, 2), // disk number start
						intToBytes(0, 2), // internal file attributes
						intToBytes(0, 4), // external file attributes
						intToBytes(localFileHeaderPos, 4), // relative offset of local header
						stringToBytes(fileEntry.fileName), // file name
						// extra field
						// file comment
					];
					const centralDirectoryHeader = concatUint8Arrays(centralDirectoryHeaderData);
					centralDirectoryHeaders.push(centralDirectoryHeader);
					centralDirectoryHeadersSize += centralDirectoryHeader.length;
					localFileHeaderPos += localFileHeader.length + fileEntry.data.length;
				});
				const endOfCentralDirectoryRecordData = [
					new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // end of central dir signature
					intToBytes(0, 2), // number of this disk
					intToBytes(0, 2), // number of the disk with the start of the central directory
					intToBytes(centralDirectoryHeaders.length, 2), // total number of entries in the central directory on this disk
					intToBytes(centralDirectoryHeaders.length, 2), // total number of entries in the central directory
					intToBytes(centralDirectoryHeadersSize, 4), // size of the central directory
					intToBytes(localFileHeaderPos, 4), // offset of start of central directory (ry
					intToBytes(0, 2), // .ZIP file comment length
					// .Zip file comment
				];
				const endOfCentralDirectoryRecord = concatUint8Arrays(endOfCentralDirectoryRecordData);
				const zipFileData = concatUint8Arrays(localFileHeaders.concat(centralDirectoryHeaders, endOfCentralDirectoryRecord));
				downloadData = new Blob([zipFileData], {type: "application/zip"});
				downloadName = file.name.replace(/((.)\.[^.]*)?$/, "$2.zip");
			}
			// 警告を出力する
			warnings.forEach((warning) => {
				const li = document.createElement("li");
				li.appendChild(document.createTextNode(warning));
				elements.warningsArea.appendChild(li);
			});
			// プレビューとダウンロード用データを出力する
			const downloadURL = URL.createObjectURL(downloadData);
			prevBlobURLs.push(downloadURL);
			elements.downloadLink.href = downloadURL;
			elements.downloadLink.setAttribute("download", downloadName);
			previewImages.forEach((image) => {
				if (elements.previewArea.firstChild) {
					elements.previewArea.appendChild(document.createElement("br"));
				}
				const imageURL = URL.createObjectURL(image);
				prevBlobURLs.push(imageURL);
				const img = document.createElement("img");
				img.setAttribute("src", imageURL);
				elements.previewArea.appendChild(img);
			});
			// 結果を表示する
			elements.resultArea.style.display = "";
		}, (error) => {
			console.error(error);
			alert("ファイルの読み込みに失敗しました。");
		}).catch((error) => {
			console.error(error);
			alert("予期せぬエラーが発生しました。");
		}).finally(() => {
			processing = false;
		});
	};

	// ファイルを選択させる
	elements.selectFileButton.addEventListener("click", () => {
		const fileInput = document.createElement("input");
		fileInput.setAttribute("type", "file");
		fileInput.setAttribute("accept", ".webm");
		fileInput.addEventListener("change", () => {
			if (fileInput.files.length === 1) {
				doExtractImages(fileInput.files[0]);
			}
		});
		fileInput.click();
	});

	// ファイルのドロップを受け入れる
	document.body.addEventListener("dragenter", (event) => {
		event.preventDefault();
		if (event.dataTransfer) {
			const fileExists = event.dataTransfer.types.indexOf("Files") >= 0;
			event.dataTransfer.dropEffect = fileExists ? "copy" : "none";
		}
	});
	document.body.addEventListener("dragover", (event) => {
		event.preventDefault();
	});
	document.body.addEventListener("drop", (event) => {
		event.preventDefault();
		if (event.dataTransfer.files.length === 1) {
			doExtractImages(event.dataTransfer.files[0]);
		} else if (event.dataTransfer.files.length > 1) {
			alert("ファイルのドロップは一度に1個だけにしてください。");
		}
	});
});
