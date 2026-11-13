# 自有 deb 网元与配置自动登记契约

日期：2026-11-12。状态：未来安装平台的设计契约，不是已实现的安装功能。

## 对用户问题的回答

可以自动知道包身份、安装了哪些声明网元和配置路径，建议在自有 deb 中附带声明式网元清单，并在安装成功后校验实际落盘结果。人工基线不是要求手工填写来源路径：自动登记可以先完成，基线有独立策略。

仅靠 deb 文件名或 dpkg 文件列表不能百分之百确定实际加载配置。deb 可以包含多个网元；postinst 可能生成配置；服务启动参数、实例和环境覆盖可能改变路径。包内容、已安装、资源纳管、进程运行和服务健康分别保存。

## 已检查的首批包

已只读核查用户给出的 `C:\Users\pc\Desktop\1101_deb\1110\debain`：26 个组件 deb（5gc 12、epc_ims 14），均为 amd64，全部有 conffiles。EPC/5GC 包内配置实际位于 /etc/xCloud/gnc、gdm、gdg、gpc、gsp 等分组；IMS 位于 /etc/xCloud/gcc。路径清单见 [首批样包检查](EXISTING_DEB_PACKAGES.md)。

首批不要求先重打全部包：增加明确包族白名单适配器，由 Package/Version/Architecture、conffiles 与载荷文件交叉生成候选来源。包自带网元清单作为长期增强。未知包只展示基本信息，不能靠名称推断资源或自动授权路径。

不能把 conffiles 整表变来源：其中有证书/私钥/schema；本轮也未发现直接随包提供的 .service。需要在安装后核验服务定义、启动参数与最终路径，并区分主 NF 和支撑进程。抽查的 postinst 中路径主要来自 echo 提示，不把提示文字当作外部启动器或实际文件证据。

## 三层依据

| 层次 | 提供的信息 | 不代表什么 |
|---|---|---|
| deb control / dpkg 状态 | Package/Version/Architecture、安装状态和包拥有文件 | 不直接给出电信角色、运行实例或全部动态文件 |
| 自有声明式网元清单 | 稳定 component/config key、domain/nfType、服务单元、配置格式与声明位置 | 未校验前不获得任意文件读取或服务控制权限 |
| 安装后校验与运行证据 | 实际主机/实例、落盘文件、最终配置路径、安装结果及后续健康证据 | 安装成功本身不证明 NF active/healthy |

Debian 明确区分配置文件与 conffiles；dpkg-query -L 不列出维护脚本额外生成文件。因此标准包信息作辅助，自己的清单和安装后校验作受控登记依据。

## 建议包内清单

建议位置为 /usr/share/xcloud/ne-manifests/<package-name>.json。这是拟定的 xCloud 契约，不是 Debian 自动识别的标准字段。清单版本化，不含 shell、脚本、口令、主机 UUID、resourceId 或 sourceId。

以下使用已检查的 MME 包及真实配置路径示范拟定清单结构；包当前未附此清单。样包未提供 .service，因此 systemdUnits 留空，不猜测服务名：

~~~json
{
  "schemaVersion": 1,
  "packageName": "xcloud-gnc-mme",
  "components": [
    {
      "key": "primary-mme",
      "domain": "epc",
      "nfType": "mme",
      "processName": "mmed",
      "systemdUnits": [],
      "configFiles": [
        {
          "key": "main",
          "path": "/etc/xCloud/gnc/mme/mme.yaml",
          "format": "yaml",
          "profile": "network-endpoints-v1",
          "origin": "package"
        },
        {
          "key": "diameter",
          "path": "/etc/xCloud/gnc/mme/diameter/mme.conf",
          "format": "diameter_conf",
          "profile": "metadata-only-v1",
          "origin": "package"
        }
      ]
    }
  ]
}
~~~

包的真实 Version/Architecture 取自包元数据，包摘要/清单摘要由安装任务记录；JSON 不可自称可信。允许一包多组件；进程/服务声明需与中央 registry 对照，不把名称当资源身份。

生成配置由可信安装执行器返回最终解析路径及 component/config key，并在安装后核验；不解析任意 postinst 脚本来猜路径，也不执行包内程序来“发现”。清单路径必须在环境授权根内，无 glob/目录递归、路径穿越或任意命令；现有 symlink/普通文件/大小/编码验证不得放宽。

## 将来安装流程

选择目标主机、受信任包和实例参数 → 包信息/网元/配置登记预览 → 执行安装 → 确认 dpkg 已完成配置且必要生成阶段完成 → 校验实际文件/实例 → 登记 Inventory 和配置来源 → 首次采集 → 按策略建立首次基线。

- 包摘要/清单信任校验不以文件名或 .deb 后缀代替；通过安装任务记录可追溯到执行者、主机与版本。
- 特权安装使用将来独立、受限执行器和显式部署授权；当前 Go Web 服务不升为 root，当前只读 Agent 不变成命令代理。
- 业务仍直接执行且保留 RBAC/Fresh Actor/CAS/日志，不引入 app_approvals 审批工单。
- 只有完整安装结果可登记；上传/解包/半配置失败都不能当作已成功安装。外部手工安装只能通过明确只读发现作为候选，再按登记策略关联。

## 来源身份和路径

host/collector、安装实例、component key 和 config key 形成服务端稳定映射，生成/复用 Inventory resourceId 和配置 sourceId。站点、运营商、网络和 PLMN 由安装任务显式选择，不从包名、目录或地址推导。包不携带任何环境通用 UUID；同版本安装到不同主机不能误合并。

- 普通升级保持同实例的 resourceId/sourceId；版本进入安装修订记录，不因版本号更换资源身份。
- 配置路径、资源绑定、格式或 profile 改变时创建新 generation；不能沿用不兼容基线。
- 包模板不等于最终配置；只监测明确选择的实际配置路径，.dpkg-new/.dpkg-dist 等候选文件不自动当作生效文件。
- 多实例逐实例登记；共享配置拥有者显式声明，避免每组件重复采集同一路径。
- 卸载保留历史，按明确安装事件撤回来源/结束比较周期；不从一次缺文件推断卸载，不自动删除资源/基线/历史。

当前 CONFIG_SNAPSHOT_MANIFEST 在启动时加载，尚无前端来源 CRUD 或包清单自动加载。未来需实现可信 catalog provider/原子重载或生成声明文件加受控重载，统一现有根/数量/身份校验；只有来源元数据不能直接授予文件读取。未实现这一接入链之前，把 JSON 放进包不会自动纳管。

## 路径约定

- 用户于 2026-11-12 确认按这批 deb 的实际布局实现，首版默认配置根为 /etc/xCloud。
- EPC/5GC：/etc/xCloud/{gnc,gdm,gdg,gpc,gsp}/<NE>/，具体 YAML 和 Diameter CONF 采用包内文件清单。
- CSCF/SMSC：/etc/xCloud/gcc/<NE>/；IPSMGW 实际位于 /etc/xCloud/gnc/ipsmgw/，按清单登记。
- 旧源码安装目录不作为本次默认、示例或自动回退来源；将来其他布局必须通过显式部署声明接入。
- 不在本次计划修订中迁移文件或改写现有运行来源。
- 根目录授权来自部署/安装策略；清单不能自行扩展根目录白名单。现有最多 16 根/128 来源限制仍适用，超过时显式提示容量/覆盖范围。

## 基线策略

| 场景 | 拟定行为 |
|---|---|
| 本期已有手工部署来源 | 继续人工明确选择基线；首次采集不自动变基线 |
| 将来可信新装且无历史基线 | 可选择 initialize_on_verified_install：安装配置阶段完成、必要校验通过、稳定采集后仅初始化一次 |
| 未配置该策略或必要验收条件不足 | 保持待建基线，不猜测/不把默认模板当现场基线 |
| 已有基线后的升级/重装/人工改配置 | 保留旧基线和漂移事实；需要接受新版本时显式发布基线 |
| 同意新配置作基线 | 记录 baseline actor/安装任务/provenance，旧周期按 baseline_superseded 结束，不写“恢复” |

未来自动初始化需由管理员在安装预览中明确选择/继承已授权策略，绑定安装任务、实际主机/来源 generation 与稳定观测；不得由任意 package 字段自行触发，也不得在每次服务启动/采集/升级后重设。初始化安装基线仍不等于声明服务健康。

## 与本期的衔接

本期漂移引擎只依赖规范 source/resource/generation/基线周期，不依赖来源是否由人工部署或未来安装登记。来源 provenance 可加法扩展为 deployment_manifest / verified_package_install；其标签不承担授权。以后自动登记仅增加可信来源入口，不重写漂移、通知和排障链。

## 标准参考

- [dpkg-deb 信息和内容查询](https://manpages.debian.org/bookworm/dpkg/dpkg-deb.1.en.html)
- [dpkg-query 文件列表与维护脚本生成文件的边界](https://manpages.debian.org/bookworm/dpkg/dpkg-query.1.en.html)
- [Debian 配置文件与 conffiles 规则](https://www.debian.org/doc/debian-policy/ch-files.html#configuration-files)

相关：[闭环开发计划](DEVELOPMENT_PLAN.md)、[设计说明](DESIGN_BRIEF.md)。
