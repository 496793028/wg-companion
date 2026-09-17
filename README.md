# WG Companion

> **wg-web 配套客户端** — 导入配置，即可看到你的名字、被授权的网段与授权模式（白名单 · 黑名单 · 全代理）；一键开关隧道、自动更新配置，全程无需打开 WireGuard 官方程序。

<p align="center">
  <b>Windows</b> · <b>macOS</b> · <b>Android</b>
</p>

---

## 这是什么

[**wg-web**](https://github.com/496793028/wg-web) 是一个 WireGuard 权限管控平台：在网页上为每个用户精细授权目的地，然后下载对应的 `.conf`。

WG Companion 是它的**独立配套客户端**：

| 能力 | 说明 |
| --- | --- |
| 📇 **导入即识别** | 解析配置内嵌的 `wg-meta` 元数据（wg-web 自动生成），界面直接显示 **真实姓名 / 授权模式徽章 / 被授权网段**；老版本配置也能按注释与文件名兜底识别 |
| 🔌 **一键开关隧道** | 无需打开 WireGuard 图形程序：Windows 走官方 `wireguard.exe` 服务化接口（`WireGuardTunnel$` 系统服务，随系统自启），macOS 走 `wg-quick`，Android 内嵌 WireGuard 官方 GoBackend（系统 VPN 服务） |
| 🔄 **自动更新配置** | 监视已导入的 `.conf`：在 wg-web 重新下载并覆盖后**自动感知并生效**；隧道在线时自动断开重连下发新配置 |
| ✨ **优雅华丽的界面** | 与 wg-web 同源设计语言（淡紫 × 鎏金徽章）：启动/入场动画、点击涟漪、连接中的呼吸光晕、卡片列表交错入场、拖放导入遮罩、开关滑动动效…… |

## 项目结构

```
wg-companion/
├── desktop/    # Electron 桌面端（Windows / macOS）
│   ├── main.js / preload.js / renderer/   # 应用
│   └── lib/core.js                        # 配置解析与平台命令（纯逻辑，带单测）
└── android/    # Android 工程（Kotlin + Compose + WireGuard 官方嵌入库）
```

## 快速开始

### Windows / macOS（桌面端）

```bash
cd desktop
npm install
npm start          # 开发运行
npm run dist       # 打包安装程序（Windows nsis / macOS dmg）
```

前置条件：

- **Windows**：安装 [WireGuard 官方 MSI](https://download.wireguard.com/windows-client/)（本应用调用其 `wireguard.exe /installtunnelservice` 服务化接口）。打包出的安装程序会请求管理员权限，隧道即以 `WireGuardTunnel$<隧道名>` 系统服务运行。
- **macOS**：`brew install wireguard-tools`（提供 `wg-quick`）。开启/关闭时系统会弹出管理员密码确认框，无需应用常驻 root。

使用：从 wg-web 用户卡片点击「客户端配置」下载 `.conf` → 拖入本应用（或点「导入配置」）→ 点开关。之后每次权限变更，只要重新下载同名配置覆盖，应用会自动更新并在隧道在线时自动重下发。

### Android

用 Android Studio 打开 `android/` 目录，直接 Run：

- 内嵌官方库 `com.wireguard.android:tunnel`（GoBackend），首次开启隧道时系统会弹出 VPN 授权；
- 支持从文件管理器直接「用 WG Companion 打开」.conf；
- 界面与桌面端同款卡片：姓名、模式徽章、网段胶囊、滑动开关。

## wg-meta 元数据协议

wg-web 生成的 `.conf` 首行附带：

```
# wg-meta v1 <base64(utf8 json)>
```

其中 JSON 为：

```json
{ "v": 1, "name": "真实姓名", "mode": "allow|deny", "proxy": 0|1, "nets": ["10.100.0.0/24", "..."] }
```

- 标准 WireGuard 客户端按注释忽略，**完全兼容**；
- WG Companion 解码后显示真实信息（中文姓名存于 base64，conf 仍保持纯 ASCII）。

## 相关项目

- **[wg-web](https://github.com/496793028/wg-web)** — WireGuard 权限管控平台（服务端/管理端）：网页授权、黑白名单、全代理模式、网关 nftables 下发。

> 在 wg-web 的 README 中也可以找到指向本项目的链接。

## License

MIT（本应用自身代码）。WireGuard® 版权归 Jason A. Donenfeld，相关组件遵循其原始许可（GPLv2 / LGPL-2.1）。
