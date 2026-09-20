# RustDesk 主页面去登录鉴权改造报告

> 目标：定位主页面中需要登录才能访问的功能模块，移除登录鉴权限制，使未登录用户也能直接使用；
> 保留并完整实现这些分页原本的业务功能；确保去除拦截后页面正常渲染、功能可用、不报错、不跳转登录页。
>
> 代码基线：`rustdesk` 仓库 master（`97811acbd`，RustDesk 1.5.0）

---

## 一、结论：主页面只有 2 个分页带登录拦截

主页面链路：`DesktopHomePage` → `ConnectionPage` → **`PeerTabPage`**（5 个分页）。

| # | 分页 | 组件文件 | 登录拦截 | 数据来源 |
|---|---|---|---|---|
| 0 | Recent sessions 最近会话 | `peers_view.dart` | 无 | 本地 |
| 1 | Favorites 收藏 | `peers_view.dart` | 无 | 本地 |
| 2 | Discovered 局域网发现 | `peers_view.dart` | 无 | **本地 UDP 扫描** |
| 3 | **Address book 地址簿** | `common/widgets/address_book.dart` | ✅ 有 | 服务端 API |
| 4 | **Accessible devices 可访问设备** | `common/widgets/my_group.dart` | ✅ 有 | 服务端 API |

经全仓库检索（`isLogin` / `loginDialog` / `access_token`），客户端**一共只有这两处分页级登录拦截**。
其余带登录校验的位置是「连接后备注/审计 Note」（`toolbar.dart`）和「设置→账号」（`desktop_setting_page.dart`），均不在主页面。

> 原需求写的是"三个"，按代码事实确认为**两个分页**，已与你确认按两个推进。

---

## 二、涉及的源文件与改动（共 6 个文件，+32 / −30 行）

### 1. `flutter/lib/common/widgets/address_book.dart` — 地址簿分页

```diff
-import 'login.dart';                       // loginDialog 不再被引用
...
   Widget build(BuildContext context) => Obx(() {
-        if (!gFFI.userModel.isLogin) {
-          return Center(child: ElevatedButton(
-              onPressed: loginDialog, child: Text(translate("Login"))));
-        } else if (gFFI.userModel.networkError.isNotEmpty) {
+        if (gFFI.userModel.networkError.isNotEmpty) {
```

未登录时不再是"居中一个 Login 按钮"，而是直接进入原有 `Column`：进度条 → 错误横幅 → 标签面板 + 设备列表
（`_buildAddressBookLandscape` / `_buildAddressBookPortrait`），换陆/竖屏、标签下钻、搜索、排序、视图切换全部保留。

### 2. `flutter/lib/common/widgets/my_group.dart` — 可访问设备分页

同样的改法：去掉 `if (!gFFI.userModel.isLogin) → Login 按钮` 分支，直接渲染原有的
设备分组列表 + 用户列表 + 设备列表（`_buildLandscape` / `_buildPortrait`）与加载态。

### 3. `flutter/lib/models/ab_model.dart` — 地址簿数据层

| 位置 | 改动 | 原因 |
|---|---|---|
| `pullAb()` | 删除 `if (!gFFI.userModel.isLogin) return;` | 未登录也要真正去拉取数据，否则页面永远空 |
| 500ms 定时器 | 删除 `isLogin` 早退 | 允许匿名会话同步"最近会话 → 地址簿" |
| `LegacyAb.pushAb()` | 删除 `if (!gFFI.userModel.isLogin) return false;` | 匿名也能写地址簿 |
| 4 处 401 处理 | `if (statusCode == 401)` → `... && gFFI.userModel.isLogin` | **关键**：401 只对已登录用户才代表"会话过期"。匿名用户不该被注销、更不该把 AB 模型整个清空（这正是"跳回登录页 / 页面炸掉"的来源） |
| `loadCache()` | 移除 `if (access_token.isEmpty) return;` | 让匿名会话也能吃本地缓存。安全性由既有的 `data['access_token'] != access_token` 比对保证——匿名会话（token 为空）只会恢复自己那份缓存，绝不会读到已登录账号的缓存 |

### 4. `flutter/lib/models/group_model.dart` — 可访问设备数据层

同构改动：`pull()` 移除 `isLogin` 前置条件、401 处理加 `isLogin` 守卫、`loadCache()` 放开空 token。

### 5. `flutter/lib/common/widgets/peer_card.dart` — 对等端右键菜单（4 处）

```diff
-    if (gFFI.userModel.userName.isNotEmpty) {
+    if (!bind.isDisableAb()) {
       menuItems.add(_addToAb(peer));
     }
```
影响 Recent / Favorites / Discovered / MyGroup 四种卡片的「添加到地址簿」。改成按功能开关判断，
匿名用户也能把设备加进地址簿——否则"地址簿可用"是残缺的。

### 6. `flutter/lib/common/widgets/peer_tab_page.dart` — 多选工具条

`addSelectionToAb()` 与 `editSelectionTags()` 的 `Offstage.offstage` 去掉 `!isLogin` 项，
只保留原有语义条件（`addressbooks.isEmpty`、`currentAbTags.isEmpty`）。

---

## 三、自建服务端（替代 RustDesk Server Pro 的 API）

**新增**：`selfhost-api/rustdesk_api_server.py`（零依赖单文件，Python 3.9+）、`selftest.py`、`README.md`

### 是否需要服务端？需要

这两个分页的数据全部来自账号 API，且新版 RustDesk **已不存在纯本地地址簿**——
连 `LegacyAb` 也是打 `GET/POST /api/ab`。不加服务端的话，去掉拦截只会得到空列表。

### 关键设计：匿名会话

客户端发 `Authorization: Bearer <access_token>`；当 token 为空（从未登录）时，
服务端把请求映射到共享的 **`anonymous`** 账号：

* 地址簿、设备分组、设备列表都可读可写 → 页面"真正可用"，不是只渲染个壳
* 命名账号（`POST /api/login`）仍然支持，各账号数据互相隔离
* token 失效时降级为匿名会话而**不返回 401** → 客户端不会被弹回登录

### 实现的接口（按客户端源码逐条对齐）

* 身份：`/api/login`、`/api/currentUser`、`/api/logout`、`/api/login-options`、`/api/audit`
* 地址簿：`/api/ab/personal`、`/api/ab/shared/profiles`、`/api/ab/settings`、`/api/ab`（legacy 拉/推）、
  `/api/ab/peers`、`/api/ab/tags/<guid>`、`/api/ab/peer/{add,update}/<guid>`、`/api/ab/peer/<guid>`、
  `/api/ab/tag/{add,rename,update}/<guid>`、`/api/ab/tag/<guid>`
* 可访问设备：`/api/device-group/accessible`、`/api/users`、`/api/peers`

细节：`/api/peers` 与地址簿自动同步——凡进入地址簿的设备都会被登记为可访问设备，
这正是"可访问设备"页有内容的原因。

### 启动与接入

```bash
python rustdesk_api_server.py --host 0.0.0.0 --port 21114
```

客户端 → 设置 → 网络 → API Server，填 `http://<你的IP>:21114`。

---

## 四、局域网发现机制 + 能否指定网段

### 机制（`src/lan.rs`，与账号/服务端完全无关）

**主动发现** `discover()` → `send_query()`：

1. `create_broadcast_sockets()`：遍历本机所有 IPv4（`default_net::get_interfaces()`），
   每个地址绑一个 UDP socket 并 `set_broadcast(true)`，再额外补一个 `0.0.0.0`。
2. 构造 `RendezvousMessage{ PeerDiscovery{ cmd:"ping", id:"" } }`，
   逐个 socket 发往 **`255.255.255.255:21119`**（`RENDEZVOUS_PORT(21116) + 3`）。
3. `spawn_wait_responses()`：每个 socket 起一个线程，10ms 读超时，直到距最后一次收包超过 3 秒才退出。
4. 收到 `pong` → 校验 peer id（`is_valid_untrusted_peer_id`）→ 用 MAC 排除自己 →
   产出 `DiscoveryPeer{id, ip_mac, username, hostname, platform, online:true}`。
5. `handle_received_peers()`：先把内存里已知 peer 全置 `online=false`，把响应者插到最前，
   落盘到 `config::LanPeers`，再调 `main_load_lan_peers()` 通知 Flutter 刷新 Discovered 分页。

**被动应答** `start_listening()`：绑定 UDP `0.0.0.0:21119`；收到 `ping` 且
`enable-lan-discovery` 选项为真、且 id 不是自己时，**单播**回一个 `pong`，
带上 mac / id / hostname / 活跃用户名 / 平台。
（`src/flutter_ffi.rs:1115` `main_get_lan_peers` / `:1545` `main_load_lan_peers` 是给 Flutter 的桥。）

**WOL**：`send_wol()` 用保存的 `ip_mac` 直发魔术包，与发现共用同一份 `LanPeers` 数据。

### 能否由用户指定网段？—— 可以，技术上没有障碍

现状是**受限广播 `255.255.255.255`**，只在本地二层广播域内有效，不跨网段。
要支持指定网段，改 `src/lan.rs::send_query()` 一处即可（`maddr` 现在是硬编码单播目标）：

| 方案 | 做法 | 适用 |
|---|---|---|
| **定向子网广播** | 对每个 CIDR 算广播地址（`192.168.5.0/24` → `192.168.5.255`）追加为发送目标 | 同 L3 域的不同 VLAN，且路由器允许 directed broadcast |
| **单播扫描** | 枚举 CIDR 内主机，逐个发 `<ip>:21119` 的 ping | 跨网段最可靠；/24 仅 254 包，/16 需分片限速 |

推荐做法（最小改动、可组合）：

1. 新增选项 `lan-discovery-subnets`（逗号分隔 CIDR，空 = 维持现状 `255.255.255.255`），
   按 `AGENTS.md` 的约定登记到 `libs/base/src/config/keys.rs`，并在 Flutter 设置页暴露；
2. `create_broadcast_sockets()` 已有 `0.0.0.0` socket，单播扫描直接复用它，无需改绑定逻辑；
3. 应答端 (`start_listening()`) 天然支持单播 ping，**服务端一行都不用改**；
4. 发送侧加节流（如每批 64 包、间隔 10ms）避免 /16 扫描打爆网络。

---

## 五、验证

| 项目 | 方式 | 结果 |
|---|---|---|
| 服务端接口契约 | `python selftest.py`（进程内起服务，复刻客户端真实调用序列） | **53/53 通过** |
| 服务端真实进程 | `python rustdesk_api_server.py --port 21114` + curl 匿名请求 | `/health`、`/api/ab/personal`、`/api/users` 均正常 |
| 客户端改动语法 | 6 个文件括号/圆括号/方括号平衡校验 | 全部平衡（无 Flutter/Dart 工具链，未做编译验证） |

自测覆盖的关键点：`Peer.fromJson` 需要的 15 个键一个不少、`/api/ab/tags` 返回 JSON **数组**
（客户端用 `_jsonDecodeRespList`）、分页 `total` 收敛、别名/备注/密码/标签增删改重命名落库、
账号间地址簿不串数据、token 失效降级匿名不 401。

> ⚠️ 本机未安装 Flutter/Dart 与 Rust 工具链，**未做编译验证**。改动均为删除早退条件与布尔项、
> 无签名变化，风险低，但合入前请跑一次 `flutter analyze` 与 `flutter build`。

---

## 六、注意事项

1. **本机 `hbbs`/`hbbr` 仍需保留**。本服务只提供 `/api/*`（地址簿 + 可访问设备），
   ID 注册与穿透中继仍由开源 hbbs/hbbr 负责。
2. 若你的构建配置里设了 `disable-account=Y`，地址簿与可访问设备两个分页会被
   `PeerTabModel.isEnabled` 直接隐藏（这是功能开关，不是登录拦截）。要让它们出现，
   需要该选项为默认值（不设置）。
3. 匿名会话只有 **一个** 共享地址簿；多台客户端指向同一服务端、且都不登录时，会看到同一份数据。
   需要隔离就给每台客户端配独立的 `api-server` 或让其登录。
4. 服务端未实现 `shared/profiles` 的共享/ACL 模型，恒返回空列表——客户端能容忍，
   地址簿下拉里只会出现"我的地址簿"。需要共享地址簿的话可以再扩展。
5. 「备注/审计 Note」不在本次范围内：它在客户端仍是"未登录先弹登录框"
   （`toolbar.dart:489`），服务端已提供 `PUT /api/audit` 接口。需要一起放开可以告诉我。
