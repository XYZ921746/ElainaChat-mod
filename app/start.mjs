// 端口不在这里指定：web/serve.mjs 自己默认从 3999 起、被占用自动往后找空闲端口，
//   本项目已有实例在跑时会把浏览器指过去再退出；需要固定端口的场景各自显式传 PORT。
if (!process.env.OPEN_BROWSER) process.env.OPEN_BROWSER = '0';

await import('./web/serve.mjs');
