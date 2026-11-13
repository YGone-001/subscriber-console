# 配置漂移告警闭环设计说明

日期：2026-11-12。状态：待实施。源码基线：develop / c8bd2d6955b17007df07a6c0b5cc587cc35c7434。
本轮仅形成开发计划；既有 .design 目录不能写入，使用本项目可写的 .plans/configuration-drift，未修改目录权限。

## 问题和目标

配置观测已有版本、人工基线、差异、定时采集和保留策略，尚缺少漂移事件、通知和人工排障的完整生命周期。用户还希望未来通过前端安装自有网元 deb 后，自动登记网元和配置路径。

来源登记回答“主机/网元/实际文件在哪里”；基线回答“哪一版作为比较参照”。自动登记、首次基线初始化、网元运行健康是三个独立事实。

## 体验原则

- 只比较成功、已发布、相同来源及兼容上下文的配置；缺文件、读取失败和无基线不制造漂移或恢复。
- 以规范 resourceId/sourceId 关联，不从包名、进程名、IP 或目录名猜测资源关系。
- 所有状态均说明证据时间、来源、基线和比较周期；配置变化不宣称故障根因。
- 一次漂移过程只保留一个开启事件；确认告警、结案和文件恢复分别处理。

## 范围

本期：中心现有声明的本机配置来源、人工基线、逐来源策略、漂移事件/确认/恢复、告警入口、通知 subject 扩展、排障锚点扩展。

本期设计后续契约：deb 的网元与配置清单、安装结果登记、首次基线可选初始化。

后续独立实施：deb 上传/安装/升级/卸载工作台、特权执行器、远端安装和 Agent 协议扩展。现有 Agent 继续只读。

## 视觉与组件

Functionalist，延续现有紧凑运维工作台、tokens、字体、中英文和明暗主题。

| 对象 | 处理 | 用户可见结果 |
|---|---|---|
| configsnapshots 的采集/Compare/lease/journal | 复用并扩展 | 有来源、基线和周期依据的评估 |
| ConfigSnapshotsPage/config-api | 修改 | 策略、评估状态、基线影响与告警链接 |
| NfAlertsPage/nf-alert-views | 修改 | 既有工作台内的配置告警视图 |
| ConfigDriftList/Detail/PolicyDialog | 新建 | 独立来源语义、确认及安全证据 |
| notify 渠道/sender/worker | 复用并扩展 | 配置告警显式订阅，旧 NF 通知兼容 |
| investigation context/create/list/UI | 修改 | 配置告警进入人工排障，旧 alertId 入口有效 |
| PageHeader/OperationsPageFrame/MetricStrip/Field/Dialog/CursorPagination/OperationFeedback/UnsavedChangesGuard | 复用 | 统一页框、字段、焦点、分页、反馈和草稿 |
| SWR/read-client/mutation-client/locale/tokens | 复用 | 无第二套认证、主题或请求运行时 |

## 交互与验证

来源详情设置基线和策略；告警视图筛选开启/历史、来源/资源/站点网络；详情看安全差异、事件、通知、确认和排障。替换基线说明旧周期将结束，此操作不修改网元配置。

检查加载/空/错误/部分/过期/失效引用/冲突、切换筛选取消旧读、URL/安全 returnTo、键盘标签和确认框焦点。覆盖 1280/768/375 明暗主题，补充实际 80%/200% 缩放。

## 排除

原始配置存储/下载、自动恢复文件、MML、任意命令、信令追踪、自动根因、多跳分析、维护窗口、租户隔离、通用调度和安装即健康推断。本次已确认默认配置根为 /etc/xCloud，具体文件采用已检查 deb 的实际路径；路径仍通过来源声明管理，不由目录名推断归属。

相关文档：[开发计划](DEVELOPMENT_PLAN.md)、[任务清单](TASKS.md)、[deb 登记契约](PACKAGE_REGISTRATION.md)。
