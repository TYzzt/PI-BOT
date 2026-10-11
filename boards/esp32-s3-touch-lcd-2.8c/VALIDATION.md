# 实机验证记录

日期：2026-10-02（Asia/Shanghai）。

## 设备识别

- 串口：`/dev/cu.usbmodem5B910686821`，板载 USB UART。
- 芯片：ESP32-S3 QFN56，revision v0.2。
- MAC：`80:45:6b:35:9e:5c`。
- PSRAM：8MB，应用读数 `8388608` bytes。
- Flash：16MB，manufacturer `20`，device `4018`。

## 原始固件备份

在写入前完整读取地址 `0x0` 起的 `16777216` bytes，保存至 `backups/original-20261002.bin`。

SHA-256：`939c7edcf3267d17d1c50c49050bac77a9f693e25c1144567925b8570da37b05`。

921600 和 460800 波特率读取均出现串口传输错误；降至 230400 后完整读取成功，用时 774.1 秒。备份成功记录见 `backups/read-flash.log`。备份与校验文件不提交 Git。

## 编译与烧录

- Arduino ESP32 core：3.0.2；LVGL：官方示例包中的 8.3.10。
- 自定义源码：`demo/BoardDemo/BoardDemo.ino`。
- 编译成功：program storage `546457` bytes；global variables `70832` bytes。
- 应用二进制大小：`546816` bytes。
- 使用 115200 波特率烧录，bootloader、分区表、boot_app0 和应用均通过 esptool 写入哈希校验。
- 烧录日志：本地 `flash.log`。

## 运行验证

烧录后读取 15 秒日志，之后通过 RTS 复位，再读取 20 秒启动日志。实际输出包括：

```text
T-AGNET BoardDemo boot
TouchPad_ID:0x39,0x31,0x31
DEMO GT911 I2C: OK
DEMO ready: LCD + GT911 touch + backlight
DEMO alive uptime=1 heap=284228 psram=8388608
```

启动过程通过 LCD 初始化错误检查，GT911 I2C 有响应，应用持续输出每秒运行日志。观察窗口内没有 panic 或反复重启，heap 稳定为 `284228` bytes。

串口通信和程序运行已验证；尚未通过相机或人工反馈验证实际屏幕显示、触摸计数和背光滑条效果。实物上应显示 **T-AGNET | ESP32-S3**，点击 **Tap me** 应增加计数，拖动 **Backlight** 应改变亮度。

本地详细日志：`runtime.log`、`startup.log`，不提交 Git。

# 动画小人版本（2026-10-02）

## 新增与集成

- 原创 LVGL 画布角色：idle、thinking、working、searching、waiting、success、error、sleeping。
- 呼吸、眨眼、注视、身体摆动、敲键盘、搜索镜、弹跳粒子等由数学曲线逐帧生成。
- ASCII 串口状态控制、触摸切换、自动轮播、12 秒主机心跳超时。
- `agent_bridge.py` 通过现有 T-AGNET 私有 Unix socket 鉴权并订阅事件，使用只读 `snapshot`/`codingGet` 恢复状态。
- 桥接实际连接成功，输出 `T-AGNET connected (read-only event subscription)`、`Buddy: idle`。本次没有人为创建模型任务；智能体各阶段映射通过接口源码核对与单元测试验证，完整真实任务的动作观感仍待用户运行任务确认。

## 修复与性能

首次 48 顶点轮廓调用 LVGL polygon 绘制在实机触发 `InstrFetchProhibited`。回溯指向 `lv_draw_sw_polygon` / drawing masks。轮廓改用直接 RGB565 scanline 填充，整帧清屏改用连续 PSRAM 写入，不再调用该 polygon 路径。

最新版本绘制实测约 **22–24ms**，先前通用画布路径约 110ms。计时只涵盖角色绘制，不代表屏幕完整刷新帧率。实机测试睡眠动画帧计数从 152 增长到 244（约 8 秒），持续运动正常。

## 最新编译与烧录

- Program storage：`575365` bytes，18%。
- Global variables：`70968` bytes，21%。
- esptool 烧录 bootloader、分区表、boot_app0、应用全部通过哈希校验。
- 原始整片备份仍为 `backups/original-20261002.bin`。
- 本地构建/烧录日志：`pet-build.log`、`pet-flash.log`。

## 验证

- 8 项 bridge 状态映射测试通过：规划结束等待审批、旧工具不影响新 run、并行写优先、浏览器搜索、历史成功不重放、run 启动清除完成等待、事件 packet 路由、睡眠不重置空闲计时。
- `tests/smoke_board.py` 实机通过：硬复位启动、8 种状态 ACK/STATUS、未知状态拒绝、超长命令拒绝后恢复、持续帧增长、恢复自动演示。
- GT911：`PET GT911=OK`。
- 实机 heap：`284092` bytes；free PSRAM：`6733372` bytes，各状态保持稳定。
- 最新观察窗口没有 panic 或反复重启。
- `preview/moods.png` 为实际 C++ 角色几何在固定时间的桌面预览，已视觉检查；不是实物拍照。实际 LCD 显示、触摸手感仍需人工查看。
- 桥接为本次手动启动的常驻进程，不自动安装登录启动项；重启电脑后运行 `./run-bridge.sh` 恢复。

# Pi Bot 更名（2026-10-11）

以上记录保留当时的 T-AGNET 名称和日志原文。项目更名为 Pi Bot 后：

- 固件与预览中的显示文字改为 Pi Bot（`Pi Bot buddy`、`LIVE / Pi Bot`、`Pi Bot | ESP32-S3`），画面几何和串口协议不变。
- `agent_bridge.py` 改为连接 `/tmp/pi-bot-<uid>-<digest>/service.sock`，默认数据目录 `~/Library/Application Support/Pi Bot`（`PI_BOT_DATA_DIR` 可覆盖）；订阅 `bot.mood` 事件，每 2 秒用只读 `status` 恢复状态，多个 Bot 同时运行时取最需要关注的状态。
- 验证：`tests/test_bridge.py` 7 项通过（socket 路径与桌面服务一致、多 Bot 优先级、表情映射与完成保持、快照忽略已结束的表情、空闲转睡眠、忽略其他事件）；socket 路径与 `desktop/packages/service/src/paths.ts` 的计算结果已对比一致。
- 未重新编译烧录，也未在实物上复验桥接；固件只改了字符串。
