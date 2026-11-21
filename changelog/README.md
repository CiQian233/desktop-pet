# 更新日志

当前及后续版本的更新日志统一存放在本目录。

- 文件名使用 `vX.Y.Z.md`，与 Git tag 和 GitHub Release 版本保持一致，例如 `v0.4.0.md`。
- 发布前更新对应版本的日期、功能变化、验收结果、产物和校验信息。
- `.github/workflows/release.yml` 使用 `changelog/${{ github.ref_name }}.md` 作为 Release 正文。
- 历史文档中的记录保留原文；新版本不再在 `docs/` 下重复创建更新日志。
