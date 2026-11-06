// dsh-provider-badge：宿主半边。
//
// 全部 UI 都在 client.js（浏览器 bundle）。这里只需要一个可被 DSH Loader 载入的
// cordis 插件外壳：让包出现在 plugin 表里，客户端模块系统才会扫描 `dsh.client`
// 并把 client.js 推给页面。不读写任何 DSH 数据、不注册服务。
//
// 本包同时是一个 bundle：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml，
// 可用 plugin_manager install_bundle 安装（本地开发也可用 install.ps1 走传统链接）。
export const name = 'dsh-provider-badge'

/** 无宿主侧行为。 */
export function apply() {}
