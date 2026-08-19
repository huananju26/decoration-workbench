# 装修工作台（在线版）

单文件 HTML 装修管理工具，已部署到 GitHub Pages。

## 在线访问

👉 **https://huananju26.github.io/decoration-workbench/**

任何设备（手机 / 电脑 / 微信内置浏览器）打开即可使用，无需安装。

## 功能模块

今日总览 / 装修流程 / 采购清单 / 装修记账 / 比价选品 / 实用工具 / 装修日记 / 水电知识 / 财务汇总。

## 云端同步（多设备）

工作台内点「☁️ 云端同步」，登录 Supabase 账号后，数据自动存云端、多设备实时同步，不同账号数据相互隔离。

- 后端可配置：在同步弹窗里填自己的 Supabase Project URL + Publishable Key 即可，不依赖任何特定账号。
- 数据存在用户自己的 Supabase 项目里，本仓库只托管网页，不含任何业务数据。

## 本地更新页面

改完 `装修工作台.html` 后，用仓库根目录的一键脚本推送：

- **最简单**：在访达（Finder）里**双击 `update_pages.command`**，自动用终端部署（窗口看完按回车关闭）。
- 或终端运行：`./update_pages.sh`

默认走 **SSH 免 token**（首次需把 `~/.ssh/github_pages.pub` 加到 GitHub → Settings → SSH and GPG keys）。

若不想配 SSH，也可临时用 token 推送：

```bash
GH_TOKEN=ghp_xxx ./update_pages.sh
```

（token 只需 `repo` 权限，生成地址：GitHub → Settings → Developer settings → Personal access tokens）

推送后约 1 分钟生效。脚本带「无改动跳过」保护：没改过内容时直接提示无需推送。

## 技术说明

- 纯单文件 HTML，CSS / JS / SVG 全内联，零外部依赖，不引任何 CDN / SDK。
- 数据默认存在浏览器 localStorage（离线兜底）；开启云端同步后自动上传到 Supabase。
- 部署源为 `main` 分支根目录的 `index.html`。
