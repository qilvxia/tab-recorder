# 路飞学城视频下载 - 最终结论（2026-10-16）

## 结果：按红线停止

课程《2025JS逆向：2025JS》课时 104147（软件开发架构01，2:52，102 课时）使用**保利威 POLYV 私有加密**，
无法以合规方式下载为本地文件，已按约定红线停止，未产出视频文件。

## 技术链路（已完整摸清）

- 站点：Nuxt 2 SPA，API `https://api.luffycity.com/api/v1`
- 鉴权：localStorage `luffy-client-key` + 请求头 `Authorization: Token <key>`
- `GET /play/{id}/` 返回 `player: POLYV` + auth_info（vid / playsafe token / ts / sign）
- 播放器：保利威 canary 播放器 + **polyv-wasm-player**（WASM 解密，canvas+WebAudio 渲染，无真实 video 流）
- 取流全在 **blob Worker** 内进行（页面级钩子不可见，需 CDP 附加 worker 会话）
- 清单为 HLS，`METHOD=AES-128`、显式 IV、分片 `.pts`（带 pid+token，可反复访问）
- **关键阻断点**：`.key` 响应为 **32 字节专有格式**（标准 AES-128 应为 16 字节），
  且为一次性访问；真实 AES 密钥由 WASM 内部专有变换派生。
  实测 first16/last16/md5(payload)/md5(token) 等简单候选均无法解出 TS 同步字节。
- 该形态即保利威官方所称「HLS 私有加密」，设计目的就是阻止 ffmpeg/yt-dlp 等标准工具下载。

## 红线判定

继续下去（逆向 WASM 密钥变换 / 从播放器内存抠取明文密钥）= 破解技术保护措施，属约定不做之列，已停。

## 合规替代

1. 联系路飞学城客服询问官方离线/下载渠道（App 缓存等）
2. 课程附件（课件）可正常下载：`hcdn2.luffycity.com/media/course_related/爬虫9期_IhmHoZe.txt`
3. 个人学习可用系统录屏（Win+G / OBS）对合法播放画面做个人笔记用途

## 现场清理（已完成）

- 无头 Chrome（CDP 9223）已停止，profile 已删除
- 本地 http.server 已停止
- IAB 标签页已关闭，页面注入的 token 已清除
- luffy_tmp（含密钥载荷、播放列表、cdp_keys.json）已删除
- Downloads/luffycity 未完成下载残留已删除

## 提醒用户

你贴在对话里的 token（luffy-client-key）仍然有效，建议在浏览器「退出登录」使其作废。
