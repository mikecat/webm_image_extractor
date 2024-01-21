再生できないwebmファイルから画像を取り出すツール
================================================

[https://mikecat.github.io/webm_image_extractor/](https://mikecat.github.io/webm_image_extractor/)

Google Chrome で [whammy](https://github.com/antimatter15/whammy) が生成した[再生できないwebmファイル](https://github.com/antimatter15/whammy/issues/70)から画像データを取り出します。

* 各画像のサイズとピクセル数の間の謎のデータを `head` チャンクに保存します。
* アニメーションWebP形式での出力時、
  * 出力画像の `ICCP` チャンク、`EXIF` チャンク、`XMP` チャンクはそれぞれ最初に現れたものをコピーします。
  * 個別画像の `ICCP` チャンク、`EXIF` チャンク、`XMP` チャンクは (最初のものを含め) それぞれ `iccp` チャンク、`exif` チャンク、`xmp` チャンクとして `ANMF` チャンク内に保存します。

関連記事：[「服を剥がすツール」が出力するwebmファイルを解析し、画像データを取り出してみた #画像 - Qiita](https://qiita.com/mikecat_mixc/items/d493fd827bcdb2922ab5)
