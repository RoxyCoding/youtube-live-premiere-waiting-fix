# youtube-live-premiere-waiting-fix

YouTubeブラウザ版で、開始済みのライブ配信・プレミア公開が待機画面のまま進まない問題を修正するTampermonkeyユーザースクリプトです。

ページ全体は再読み込みしません。動画プレーヤーだけを再接続するため、チャットやページの表示状態を維持できます。

## 対応する問題

- 開始時刻を過ぎても待機画面から再生へ切り替わらない
- 「○分後にライブ配信」「○秒後にライブ配信」の表示が停止する

## 対応環境

- Chrome / EdgeなどのChromium系ブラウザ
- Tampermonkey

## YouTube Data APIキーの準備

このスクリプトは公開動画の情報だけを読むため、OAuthではなくAPIキーを使用します。

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成または選択します。
2. [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)を有効にします。
3. 「APIとサービス」→「認証情報」からAPIキーを作成します。
4. キーの「APIの制限」を`YouTube Data API v3`に設定することを推奨します。
5. YouTube上でTampermonkeyメニューを開き、「YouTube Data API キーを設定」を選びます。
6. APIキーを入力して保存します。

初回起動時に表示される入力欄から設定することもできます。キーはTampermonkeyの保存領域に格納され、ソースコードには書き込みません。

## APIクォータと負荷

複数タブでは使用量がタブ数に応じて増えます。Google Cloud Consoleでクォータ使用量を確認してください。

参考：[Videos: list](https://developers.google.com/youtube/v3/docs/videos/list)、[クォータ使用量](https://developers.google.com/youtube/v3/determine_quota_cost)