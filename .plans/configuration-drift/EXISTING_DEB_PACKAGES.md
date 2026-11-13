# 自有网元 deb 只读检查

日期：2026-11-12。只读检查，不安装、不执行维护脚本或 ELF，不提取或保存配置原文/证书/私钥内容。

样本目录：`C:\Users\pc\Desktop\1101_deb\1110\debain`。

26 个包全部成功检查（5gc 12、epc_ims 14），均为 amd64；全部包含 conffiles。按本轮配置扩展名筛选得到 56 个候选，其中 54 个在 /etc/xCloud，另 2 个是系统动态库配置。113 条 conffiles 声明中还包含证书、私钥、schema 和辅助文件，不能整表纳管。

26 个包控制和数据成员均使用 zstd；在独立结果目录内使用 zstandard 0.25.0 解码。逐包检查前后 SHA256、大小和 mtime 一致，错误数 0。

## 包内事实

| 包 | 版本 | conffiles 数 | 配置候选路径 |
|---|---|---:|---|
| xcloud-gdg-upf | 50V208p1-ubuntu24.04 | 1 | `/etc/xCloud/gdg/upf/upf.yaml` |
| xcloud-gdm-ausf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gdm/ausf/ausf.yaml` |
| xcloud-gdm-udm | 50V208p1-ubuntu24.04 | 11 | `/etc/xCloud/gdm/udm/udm.yaml` |
| xcloud-gdm-udr | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gdm/udr/udr.yaml` |
| xcloud-gnc-amf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gnc/amf/amf.yaml` |
| xcloud-gnc-bsf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gnc/bsf/bsf.yaml` |
| xcloud-gnc-nssf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gnc/nssf/nssf.yaml` |
| xcloud-gnc-sepp | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gnc/sepp/sepp.yaml` |
| xcloud-gnc-smf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gnc/smf/smf.yaml` |
| xcloud-gpc-pcf | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gpc/pcf/diameter/pcf.conf`<br>`/etc/xCloud/gpc/pcf/pcf.yaml` |
| xcloud-gsp-nrf | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gsp/nrf/nrf.yaml` |
| xcloud-gsp-scp | 50V208p1-ubuntu24.04 | 4 | `/etc/xCloud/gsp/scp/scp.yaml` |
| xcloud-gcc-icscf | 50V601p3-ubuntu24.04 | 4 | `/etc/xCloud/gcc/icscf/icscf.cfg`<br>`/etc/xCloud/gcc/icscf/icscf.xml`<br>`/etc/xCloud/gcc/icscf/icscf_main.cfg`<br>`/etc/xCloud/gcc/icscf/vars.cfg` |
| xcloud-gcc-pcscf | 50V601p3-ubuntu24.04 | 12 | `/etc/xCloud/gcc/pcscf/dispatcher.list`<br>`/etc/xCloud/gcc/pcscf/pcscf.cfg`<br>`/etc/xCloud/gcc/pcscf/pcscf.xml`<br>`/etc/xCloud/gcc/pcscf/pcscf_main.cfg`<br>`/etc/xCloud/gcc/pcscf/route/cdr.cfg`<br>`/etc/xCloud/gcc/pcscf/route/mo.cfg`<br>`/etc/xCloud/gcc/pcscf/route/mt.cfg`<br>`/etc/xCloud/gcc/pcscf/route/register.cfg`<br>`/etc/xCloud/gcc/pcscf/route/rtp.cfg`<br>`/etc/xCloud/gcc/pcscf/route/websocket.cfg`<br>`/etc/xCloud/gcc/pcscf/route/xmlrpc.cfg`<br>`/etc/xCloud/gcc/pcscf/vars.cfg` |
| xcloud-gcc-scscf | 50V601p3-ubuntu24.04 | 8 | `/etc/xCloud/gcc/scscf/dispatcher.list`<br>`/etc/xCloud/gcc/scscf/scscf.cfg`<br>`/etc/xCloud/gcc/scscf/scscf.xml`<br>`/etc/xCloud/gcc/scscf/scscf_main.cfg`<br>`/etc/xCloud/gcc/scscf/vars.cfg` |
| xcloud-gcc-smsc | 50V601p3-ubuntu24.04 | 3 | `/etc/xCloud/gcc/smsc/smsc.cfg`<br>`/etc/xCloud/gcc/smsc/smsc_main.cfg`<br>`/etc/xCloud/gcc/smsc/vars.cfg` |
| xcloud-gdg-pgwu | 50V208p1-ubuntu24.04 | 1 | `/etc/xCloud/gdg/pgwu/pgwu.yaml` |
| xcloud-gdg-sgwu | 50V208p1-ubuntu24.04 | 1 | `/etc/xCloud/gdg/sgwu/sgwu.yaml` |
| xcloud-gdm-hss | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gdm/hss/diameter/hss.conf`<br>`/etc/xCloud/gdm/hss/hss.yaml` |
| xcloud-gnc-ipsmgw | 50V107-ubuntu24.04 | 3 | `/etc/ld.so.conf.d/libipsmgw.conf`<br>`/etc/xCloud/gnc/ipsmgw/ipsmgwConfig.ini`<br>`/etc/xCloud/gnc/ipsmgw/redis.conf`<br>`/etc/xCloud/gnc/ipsmgw/sau/IPSMGW-SAU.cfg` |
| xcloud-gnc-mme | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gnc/mme/diameter/mme.conf`<br>`/etc/xCloud/gnc/mme/mme.yaml` |
| xcloud-gnc-ocs | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gnc/ocs/diameter/ocs.conf`<br>`/etc/xCloud/gnc/ocs/ocs.yaml` |
| xcloud-gnc-pgwc | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gnc/pgwc/diameter/pgwc.conf`<br>`/etc/xCloud/gnc/pgwc/pgwc.yaml` |
| xcloud-gnc-sgwc | 50V208p1-ubuntu24.04 | 1 | `/etc/xCloud/gnc/sgwc/sgwc.yaml` |
| xcloud-gpc-pcrf | 50V208p1-ubuntu24.04 | 5 | `/etc/xCloud/gpc/pcrf/diameter/pcrf.conf`<br>`/etc/xCloud/gpc/pcrf/pcrf.yaml` |
| xcloud-gsp-dra | 50V111p2-ubuntu24.04 | 2 | `/etc/ld.so.conf.d/libdra.conf`<br>`/etc/xCloud/gsp/dra/dra.cfg` |

## 安装与实际运行边界

- 本轮载荷中未发现 .service 单元，也未发现计划提出的 ne-manifest 清单。抽查 SMF、S-CSCF、IPSMGW、DRA 的 postinst，路径主要出现在安装完成的 echo 提示中；IPSMGW/DRA 还包含 ldconfig。提示文本不是外部启动器调用或脚本实际存在的证据，均未执行。
- 组件 Depends 引用但本目录没有的包：`xcloud-common-5gc`、`xcloud-libkims`、`xcloud-linux-gnu`、`xcloud-xdev`。只说明未在样本目录中，不代表目标 Linux 未安装。
- 目标环境的服务定义、启动参数、基础依赖、动态配置生成、多实例和安装后状态仍需专门验证；不能用 postinst 的提示文字代替文件或运行证据。
- IPSMGW 包内有 ipsmgwd、redis-server、saud；应区分主网元与支撑程序，不把三个可执行文件都登记为同类 NF。DRA 等支撑组件继续遵守中央 registry 的纳管/监测资格。
- 用户于 2026-11-12 确认本次按已核查的 deb 布局实现：默认根 /etc/xCloud，EPC/5GC 按 gnc/gdm/gdg/gpc/gsp 分组，CSCF/SMSC 按 gcc 分组，IPSMGW 按 gnc/ipsmgw。只登记明确文件，不回退扫描旧源码安装路径；本轮未迁移文件或更改运行来源。

## 对计划的调整

首批使用已知包族白名单适配器读取 control、conffiles、载荷文件以及二进制路径，输出候选来源；不是让未知包名拥有任意读取权限。长期支持包自带网元清单，但它不是这批包接入预览的强制前提。安装后校验才建立主机/实例/资源映射和实际来源；首次基线按独立策略建立，升级不静默替换基线。

## 证据

`C:/Users/pc/.codex/visualizations/2026/11/09/01a1bf3b-fa31-7f32-8ce2-f19dea4b9eb0/configuration-drift-debs-20261112/package-audit.json`：包摘要、控制字段、文件路径、脱敏静态维护脚本线索。
`C:/Users/pc/.codex/visualizations/2026/11/09/01a1bf3b-fa31-7f32-8ce2-f19dea4b9eb0/configuration-drift-debs-20261112/source-packages.sha256`：26 个原始 deb 的 SHA256。
`C:/Users/pc/.codex/visualizations/2026/11/09/01a1bf3b-fa31-7f32-8ce2-f19dea4b9eb0/configuration-drift-debs-20261112/inspect_debs.py`：只读检查器。

相关：[deb 登记契约](PACKAGE_REGISTRATION.md)、[开发计划](DEVELOPMENT_PLAN.md)。
