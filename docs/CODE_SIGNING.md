# 代码签名（Windows）

## 为什么需要

`CalicoPet-portable-*.exe` 和 `CalicoPet-setup-*.exe` 目前是 **NotSigned**。
未签名的 exe 从网上（GitHub Release、网盘）下载后会被 Windows 打上 MOTW 标记，
用户双击时会遇到：

| 现象 | 后果 |
| --- | --- |
| SmartScreen「Windows 已保护你的电脑 / 未知发布者」 | 要点「更多信息 → 仍要运行」才能装，**大部分人会直接放弃** |
| 杀软启发式查杀 | 便携版是 NSIS 自解压结构，最容易被误报 |
| 企业 AppLocker / WDAC 策略 | 直接拦死，无法绕过 |

签名不能消除所有误报，但能解决 SmartScreen 的「未知发布者」和绝大多数策略拦截。

---

## 三条可行路线

> ⚠️ 自 2023 年 6 月起（CA/Browser Forum 基线要求），**公开信任的代码签名证书
> 私钥必须存放在 FIPS 140-2 Level 2 及以上的硬件中**（USB Token 或云 HSM）。
> 也就是说：你**再也买不到一个可以直接放进 CI 的 `.pfx` 文件**了。
> 任何声称能给你纯 pfx 的渠道都不可信。

### 路线 A：Azure Trusted Signing（推荐先试）

微软自己的托管签名服务，私钥在微软的 HSM 里，CI 通过 Entra ID 调用。

- **费用**：约 US$9.99/月（含一定免费额度）
- **门槛**：需要完成身份验证（Identity Validation）
  - 组织验证：要求 **3 年以上可验证的经营历史** —— 个人开发者/学生基本走不通
  - 个人验证：仅部分国家/地区开放，且社区反馈审核较难
- **优点**：不用管证书续期/Token 丢失，CI 配置最干净

### 路线 B：SignPath.io（开源项目免费）

面向开源项目的免费签名服务，证书由他们持有，签名在他们的云上完成。

- **费用**：开源项目免费（SignPath Foundation）
- **门槛**：需要 OSI 认可的开源许可证、活跃的公开仓库、一定的项目成熟度
- **流程**：提交申请 → 审核通过后在他们的后台配置策略 → 在 GitHub Actions 里加一步
- **对本项目**：MIT 许可证已满足，是**最现实的一条路**

### 路线 C：购买 OV / EV 证书

- **费用**：约 US$200–500/年（DigiCert / Sectigo / SSL.com / Certum 等），另加硬件 Token 或云 HSM 费用
- **EV vs OV**：EV 能**立即**建立 SmartScreen 信誉；OV 需要靠下载量慢慢累积
- **门槛**：需要营业执照或身份证明；个人可申请 OV，但审核严格
- **对个人项目**：性价比最低

### 不推荐：自签名证书

自签名证书签出来的 exe，**只在导入了该证书的机器上有效**。
其他用户看到的仍然是「未知发布者」，甚至比不签更糟（多了个不受信任的证书）。
仅用于本地验证签名管线，或企业内部通过组策略分发。

---

## 本项目已经接好的部分

签名配置已经完成，**你只需要拿到证书，然后设置环境变量**。

### 配置在哪

- 基础打包配置仍在 `package.json` 的 `build` 字段
- `electron-builder.config.cjs` 在其上叠加签名逻辑，**完全由环境变量驱动**，
  仓库里不会出现任何证书或密钥
- `scripts/pack.ps1` 会调用该配置，并在结尾打印每个产物的签名状态

### 方式一：证书文件（OV/EV 的 Token 导出，或自签名）

electron-builder 原生支持，**不需要改任何配置**，设置环境变量即可：

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"      # 也可以是 pfx 的 base64
$env:CSC_KEY_PASSWORD = "证书密码"
.\scripts\pack.ps1
```

### 方式二：Azure Trusted Signing

设置以下环境变量（缺任意一个则自动跳过签名，不会报错）：

```powershell
$env:AZURE_TRUSTED_SIGNING_ENDPOINT = "https://<区域>.codesigning.azure.net"
$env:AZURE_TRUSTED_SIGNING_ACCOUNT  = "你的 Code Signing Account 名"
$env:AZURE_TRUSTED_SIGNING_PROFILE  = "你的 Certificate Profile 名"
# Entra ID 凭据，由 Trusted Signing 客户端自行读取
$env:AZURE_TENANT_ID     = "..."
$env:AZURE_CLIENT_ID     = "..."
$env:AZURE_CLIENT_SECRET = "..."
.\scripts\pack.ps1
```

### 方式三：什么都不设

```powershell
.\scripts\pack.ps1
```

会明确打印 `[sign] no signing material found -> artifacts will be UNSIGNED`，
并照常产出未签名的 exe。

---

## 验证签名管线（自签名，不影响正式产物）

想先确认整条链路能跑通，又还没有真证书：

```powershell
# 1. 生成一张自签名代码签名证书
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=CalicoPet Test Signing" `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(1)
$pfx = "$env:TEMP\test-sign.pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfx `
  -Password (ConvertTo-SecureString 'testpass123' -Force -AsPlainText)

# 2. 带证书打包到独立目录，避免覆盖正式产物
$env:CSC_LINK = $pfx
$env:CSC_KEY_PASSWORD = 'testpass123'
npx electron-builder --win portable --config electron-builder.config.cjs `
  --config.directories.output=dist/signtest

# 3. 检查结果：Signer 应显示 CN=CalicoPet Test Signing
Get-AuthenticodeSignature dist\signtest\CalicoPet-portable-0.1.0.exe | Format-List Status, SignerCertificate

# 4. 清理
Remove-Item dist\signtest -Recurse -Force
Remove-Item $pfx -Force
```

`Status` 会是 `UnknownError` —— 因为自签名证书的链不受信任，这是**预期结果**。
拿到真实证书后同样的命令会返回 `Valid`。

---

## CI 里怎么配

`.github/workflows/release.yml` 已经写好：打 tag（`v*`）时自动构建、签名、发布 Release。
签名是**可选**的——对应的 Secrets 不存在就自动产出未签名产物，工作流不会失败。

在 `Settings → Secrets and variables → Actions` 里按所选路线添加：

| 路线 | 需要的 Secrets |
| --- | --- |
| Azure Trusted Signing | `AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_CLIENT_SECRET`、`AZURE_SUBSCRIPTION_ID`、`AZURE_TRUSTED_SIGNING_ENDPOINT`、`AZURE_TRUSTED_SIGNING_ACCOUNT`、`AZURE_TRUSTED_SIGNING_PROFILE` |
| 证书文件 | `WIN_CSC_LINK`（pfx 的 base64）、`WIN_CSC_KEY_PASSWORD` |

> 用证书文件路线时，**不要把 .pfx 提交进仓库**。`.gitignore` 已排除 `*.pfx` / `*.p12` 之外的常见密钥文件，
> 但最稳妥的做法始终是只放 Secrets。
