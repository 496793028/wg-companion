# WG Companion v1.0.0

wg-web 的配套客户端：导入 `.conf` 即显示**姓名 / 授权模式（白名单 · 黑名单 · 全代理）/ 授权网段**，一键开关隧道、自动更新配置，**无需打开 WireGuard 官方程序**。

## 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `WG Companion Setup 1.0.0.exe` | 分步安装器（可选安装目录 + 可选桌面/开始菜单快捷方式 + 控制面板卸载） |
| Android | `app-debug.apk` | 侧载安装包（内嵌官方 WireGuard GoBackend） |

## Windows

1. 运行 `WG Companion Setup 1.0.0.exe`（需**管理员权限**，隧道要注册为系统服务 `WireGuardTunnel$<隧道名>`）。
2. 安装向导：选择安装目录 → 勾选要创建的快捷方式 → 完成。
3. 从 wg-web 用户卡片下载 `.conf`，拖入应用或点「导入配置」即可开关隧道。
4. **服务端自动更新**（设置中默认开启）：由新版本 wg-web 下发的 `.conf` 会携带服务端地址与只读令牌，客户端据此按间隔自动从服务端拉取最新配置并生效（隧道在线时自动重下发），无需手动重新下载。可在「设置」中调整检查间隔、关闭自动更新或允许自签名证书。

> ⚠️ 安装包**未代码签名**，Windows SmartScreen 会提示「未知发布者」，点「仍要运行」即可。

## Android

1. 允许「未知来源」安装后，点击 `app-debug.apk` 安装。
2. 首次开启隧道时系统会弹出 VPN 授权；从文件管理器「用 WG Companion 打开」`.conf` 也可直接导入。

> 注：本包为 debug 签名，便于分发测试；正式发布建议改为 release 签名包。

> ⚠️ **服务端自动更新依赖新版本 wg-web**：需把 `VPN权限管控平台` 的 `server.js` 更新到含 `GET /api/client/conf?token=` 接口的版本，并停服后用 `--init` 加 `client_token` 列后重启。旧版 wg-web 下发的 `.conf` 不含自动更新信息，客户端不会自动拉取（重新下载一次即可）。


## 相关

- 服务端 / 管理端：[wg-web](https://github.com/496793028/wg-web)
