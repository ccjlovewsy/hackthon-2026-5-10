# OpenHarmony 编译计划与结果预测

> 日期：2026-08-10
> 说明：当前无 OpenHarmony 目标设备，本文档为编译流程计划与产物预测，不实际触发编译。

## 一、编译目标

| 项 | 取值 |
|----|------|
| 源码版本 | OpenHarmony 5.0 Release（master 分支亦同） |
| 目标形态 | standard（标准系统） |
| 目标产品 | rk3568（RK3568 开发板，社区主流参考板） |
| 构建系统 | hb（HarmonyOS Build，基于 GN + Ninja） |
| 输出目录 | `out/rk3568/` |

> 备选产品：`hi3516dv300`、`ohos-arm64`（纯 OHOS 应用运行时，无内核）。

## 二、环境准备（前置条件）

### 1. 主机环境
- OS：Ubuntu 20.04 LTS（官方推荐），macOS / Windows 不支持直接编译
- CPU：≥ 8 核（推荐 16 核，否则编译极慢）
- 内存：≥ 16GB（推荐 32GB，链接阶段峰值高）
- 磁盘：≥ 100GB 可用空间（源码 ~30GB + 预编译工具链 ~10GB + 构建产物 ~40GB）
- 网络：可访问 gitee.com（`repo` 拉取）与华为镜像站（prebuilts）

### 2. 依赖安装
```bash
# 官方一键脚本
sudo apt-get update
sudo apt-get install -y curl git python3 python3-pip ruby ccache \
    build-essential gcc g++ make zip unzip tar dosfstools mtools \
    mtd-utils scons genext2fs libssl-dev libxml2-utils
pip3 install --user build hb
```

### 3. 工具链配置
- Python：3.9 ~ 3.11（3.12+ 部分脚本不兼容）
- Node：build 流程会自动下载对应版本到 `prebuilts/`
- `ccache`：建议开启，二次编译加速 30%+

## 三、获取源码

```bash
# 1. 安装 repo
curl https://storage.googleapis.com/git-repo-downloads/repo > /usr/local/bin/repo
chmod a+x /usr/local/bin/repo

# 2. 初始化（以 5.0 Release 为例）
mkdir openharmony && cd openharmony
repo init -u https://gitee.com/openharmony/manifest.git -b OpenHarmony-5.0-Release --no-repo-verify
repo sync -c -j8        # 首次约 1~3 小时，视网络
repo forall -c 'git lfs pull'   # 大文件（预编译工具链）
```

## 四、编译流程

```bash
cd openharmony

# 1. 安装 hb 与预编译工具
pip3 install --user build hb
bash build/prebuilts_download.sh     # 下载 node / python / llvm 等

# 2. 设置产品
hb set --root .
# 交互选择：rk3568

# 3. 全量编译
hb build -f                          # -f 全量，不加 -f 为增量

# 或直接指定：
hb build -f --product rk3568
```

### 编译阶段拆解（hb 内部）

| 阶段 | 工具 | 主要产出 | 预计耗时（16 核） |
|------|------|---------|------------------|
| 1. GN 生成 | `gn gen` | `out/rk3568/build.ninja` | ~1 min |
| 2. 预处理/拷贝资源 | python 脚本 | `out/.../packages/phone/` | ~3 min |
| 3. C/C++ 编译 | clang + ninja | `.o` | ~25 min |
| 4. ArkTS/JS 编译 | node + tsc/ark-compiler | `*.abc` | ~10 min |
| 5. 链接 | ld/lld | `.so` / 可执行 | ~8 min |
| 6. 资源打包 | `hap`/`img` 工具 | `*.hap`, `system.img` | ~5 min |
| 7. 镜像生成 | `mkfs.*` / `genext2fs` | `*.img` | ~3 min |
| **合计** | — | — | **~55 min（首次全量）** |

## 五、预测产物

编译成功后 `out/rk3568/packages/phone/` 下生成关键镜像：

| 文件 | 说明 | 预测大小 |
|------|------|---------|
| `images/u-boot.bin` | Bootloader | ~1 MB |
| `images/boot_linux.img` | 内核 + initramfs | ~12 MB |
| `images/system.img` | 根文件系统（system） | ~1.8 GB |
| `images/vendor.img` | 厂商分区 | ~350 MB |
| `images/syspart.img` | 系统分区 | ~200 MB |
| `images/userdata.img` | 用户数据（空） | ~50 MB |
| `images/resource.img` | 资源分区 | ~20 MB |

应用包产物：
- `out/rk3568/.../hap/`：系统应用 `.hap` 文件（SystemUI、Launcher、Settings、HapAnalyzer 等），单个 ~5–40 MB，合计 ~500 MB
- `out/rk3568/.../abc/`：ArkTS 字节码 `.abc`

## 六、结果预测汇总

| 维度 | 预测值 |
|------|--------|
| 编译状态 | ✅ 成功（环境正确时） |
| 全量耗时 | 50–60 min（16C32G + SSD） |
| 增量耗时 | 5–15 min（仅改单模块） |
| 产物总大小 | `out/` ≈ 35–45 GB |
| `system.img` | ~1.8 GB |
| 烧录方式 | RKDevTool（Windows）或 `upgrade_tool`（Linux）将上述 img 烧到 eMMC |
| 风险点 | 见下表 |

## 七、风险与对策

| 风险 | 现象 | 对策 |
|------|------|------|
| prebuilts 下载失败 | `prebuilts_download.sh` 报 404 | 切华为镜像源 / 手动补全 |
| Python 版本过高 | hb 报 AttributeError | 用 pyenv 固定 3.10 |
| 内存不足 | 链接阶段 OOM killed | 加 swap 16G 或降到 `-j8` |
| 磁盘不足 | ninja 写盘失败 | 预留 ≥100GB，定期 `ccache -C` |
| LFS 未拉取 | 缺二进制导致编译失败 | `repo forall -c 'git lfs pull'` |
| 分支不匹配 | hb set 找不到产品 | 确认 manifest 分支与产品目录一致 |

## 八、验证清单（编译完成后）

- [ ] `out/rk3568/packages/phone/images/` 下 7 个 img 齐全
- [ ] `out/rk3568/build.ninja` 存在（GN 成功）
- [ ] 无 `FAILED:` 的 ninja 日志
- [ ] `system.img` 可 `file` 识别为 ext2/4 镜像
- [ ] `ccache -s` 命中率 > 0（二次编译）
