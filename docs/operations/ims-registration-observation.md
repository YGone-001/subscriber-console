# IMS 注册观测操作说明

入口：UE 信息 → IMS 注册观测，或站点／网络工作台 → IMS 注册观测。
路径为 `/ims-registrations`。功能提供只读数据库证据，不执行注册、注销、
强制下线、MML、抓包或网元配置修改。

## 1. 先确认来源资格

部署者应确认 S-CSCF 的版本、表结构、`reg_state` 枚举、到期时间、时区与持久化方式。
适配器只支持已经核验的原生列与注册值 `1`（`0` 为未注册，`-1` 为保留服务资料的未注册）。源码检查或数据库表存在不能替代
实际运行网元的版本／配置确认。

2026-11-11 检查的 `/etc/xCloud/gcc/scscf` 配置声明 `db_mode=0`，
数据库中有历史 Contact 记录。内存模式下，数据库不能证明当前注册，来源应配置为
`memory_only` 并显示不可用。不要为让页面显示数字而把来源声明改成 `write_back`。
切换网元持久化模式及服务操作由部署者另行评估，本功能不会执行。

同一次检查发现现有 S-CSCF/HSS 应用账号含写权限。它们仅用于获授权的只读结构核验，
没有写入源码或连接示例；正式观测需要专用只读账号。

现有 BinRPC 控制套接字不是当前适配器的数据源。运行时注册采集仍需固定只读接口的
资格核验，不通过任意 shell 或通用 RPC 代替；`ulscscf.snapshot` 会写文件，不能使用。

## 2. 由数据库管理员创建最小只读账号

以下是待管理员审核执行的示例，开发过程未执行。请修改账号 host、实际库名和密码，
并使用本机数据库连接方式输入管理员凭据。密码占位符必须换成新生成的值。

```sql
CREATE USER 'xcloud_ims_scscf_reader'@'127.0.0.1'
  IDENTIFIED BY '<new-scscf-reader-password>';
GRANT SELECT (id, impu, reg_state) ON scscf.impu
  TO 'xcloud_ims_scscf_reader'@'127.0.0.1';
GRANT SELECT (impu_id, contact_id) ON scscf.impu_contact
  TO 'xcloud_ims_scscf_reader'@'127.0.0.1';
GRANT SELECT (id, contact, expires) ON scscf.contact
  TO 'xcloud_ims_scscf_reader'@'127.0.0.1';

CREATE USER 'xcloud_ims_hss_reader'@'127.0.0.1'
  IDENTIFIED BY '<new-hss-reader-password>';
GRANT SELECT (id, identity) ON hss_db.impi
  TO 'xcloud_ims_hss_reader'@'127.0.0.1';
GRANT SELECT (id, identity) ON hss_db.impu
  TO 'xcloud_ims_hss_reader'@'127.0.0.1';
GRANT SELECT (id_impi, id_impu) ON hss_db.impi_impu
  TO 'xcloud_ims_hss_reader'@'127.0.0.1';
```

这些授权不包含 K、OP、OPc、认证向量或完整订阅内容。应用会读取自己的授权并拒绝
带写权限／授权转授权／未解析角色的连接。无需 `FLUSH PRIVILEGES`。

## 3. 部署来源清单和凭据引用

从 [声明示例](../../deploy/examples/ims-registration-sources.json) 创建受控配置文件。
把资源 UUID 换成实际有效的 IMS NF／NF 实例 UUID，修改来源名称、身份权威、地址与库名。
`resourceId` 用于组织范围，不表示 UE 是该资产，也不证明 UE 地理位置。

Go 运行环境读取：

```text
IMS_REGISTRATION_SOURCES_FILE=/etc/xcloud/ims-registration-sources.json
IMS_LOCAL_SCSCF_PASSWORD=<dedicated-reader-password>
IMS_LOCAL_HSS_PASSWORD=<dedicated-reader-password>
```

示例保留 `persistence=memory_only`。只有部署模式和实际同步行为已经核验后，才可使用
`write_back` 读取数据库观测。即使如此，来源新鲜度仍显示未知，读取时间不等于最后注册时间。
远程数据库必须配置 CA 与预期服务器名称；浏览器始终通过现有应用入口访问。
配置与凭据由部署者保管，权限限制为实际 Go 运行账号需要的最小范围。

HSS 是可选补充。没有 HSS 时可以读取绑定；没有明确 IMSI 列映射时，界面不提供
推导的 IMSI。私有身份出现多条时显示歧义，不自动选第一条关联到签约用户。

修改服务运行环境后，按 [生产拓扑说明](../architecture/production-topology.md)
更新构建并由环境拥有者重启实际 Go 服务；本说明不假定服务单元名称。
若只更新 Vite 页面而未更新 Go，新增 API 不会生效。

## 4. 使用和解释结果

选择来源、网络标识、运营商标签或来源 PLMN；站点／主机选择从分组工作台携带。
PLMN 保留五／六位及前导零。点击“查看证据”可检查当前身份的有界 Contact 和可选 HSS 关联。

- 有效 Contact 绑定按来源内 Contact ID 去重；同一绑定关联多个 IMPU 不重复计数。
- 公开身份数量独立于 Contact 数，不能解释成真实人数或物理设备数。
- 分组选择来源所属组织，不表示 UE 的位置、归属网络或漫游关系。
- “数据库中未观测到有效绑定”不证明注销或设备离线；无源和失败不显示精确零值。
- 读取不完整时精确总量为不可用，“已观测”只表示返回证据的下界。
- 读取时间与同步新鲜度分开显示；新鲜度未知时不宣称当前运行内存已经同步。
- 来源变化会重置分页；游标过期或归属变更时按“第一页”重新开始。

默认手动刷新，可选每三十秒刷新；后台标签页暂停轮询。中英文与明暗主题沿用全局设置。

## 5. 验证和故障处理

先核对每个来源的状态与理由，再检查只读账号、凭据引用、表结构和配置声明。
服务不会返回原始连接错误、口令或数据库路径。`readonly_account_required` 表示应使用
专用只读账号；`persistence_not_current` 表示该数据库不能作为当前注册来源。
超时、行上限和未知状态保留部分／未知语义，不通过扩大超时或改为零消除提示。

隔离验收使用自有临时 MySQL 进程与 fixture；不会在生产库建表或写测试身份：

```bash
cd backend
IMS_TEST_MYSQLD=1 GOTOOLCHAIN=go1.24.4 go test -count=1 \
  -run TestMySQLNativeProjectionAndIdentityMapping -v ./internal/imsreg
```

真实环境验收需要现场人员正常操作 UE 注册、续期、注销，核对运行时和数据库的证据
与延迟，并分别记录多个来源。合成数据和构建通过不能替代此项验收。

本模块没有安装外部数据库索引。超过受控预算的规模应先检查执行计划，索引修改由数据库
拥有者独立审核执行，不在 GET 或启动路径创建。
