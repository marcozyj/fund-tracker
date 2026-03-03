![GitHub Actions](https://github.com/marcozyj/fund-tracker/actions/workflows/deploy-pages.yml/badge.svg?branch=test)
![GitHub Repo stars](https://img.shields.io/github/stars/marcozyj/fund-tracker?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/marcozyj/fund-tracker?style=flat-square)
![GitHub issues](https://img.shields.io/github/issues/marcozyj/fund-tracker?style=flat-square)
![GitHub last commit](https://img.shields.io/github/last-commit/marcozyj/fund-tracker?style=flat-square)
![GitHub license](https://img.shields.io/github/license/marcozyj/fund-tracker?style=flat-square)
![Repo views](https://komarev.com/ghpvc/?username=marcozyj&repo=fund-tracker&style=flat-square)

# 基金看板项目

## 用途
本项目用于展示基金的净值、估值、历史走势、持仓与自选列表等信息，并提供持仓维护与加减仓记录的前端交互界面。数据来源为公开基金数据接口，仅用于展示与参考。

## 项目特色
- 自选/持仓双视图：卡片概览 + 单基金详情弹窗
- 净值走势图表：支持一年/半年/一月切换，交易点位标记
- 历史净值分页表 + 基金持仓明细展示
- 持仓管理：加仓、减仓、批量调仓、历史操作记录
- OCR 截图导入：自动识别基金与交易记录，金额/份数可编辑
- 前端直连公开接口，支持 GitHub Pages 静态部署（test分支支持部署，但仍有bug，部署存在有些历史净值不显示的问题）
- 数据本地保存（localStorage），不上传个人数据

## 本地开发与调试
1. 安装依赖：

```bash
npm install
```

2. 启动开发服务：

```bash
npm run dev
```

3. 浏览器访问：

```
http://localhost:3000
```

## 数据与存储说明
- 数据来源：东方财富/天天基金等公开接口（仅展示，不提供交易入口）。
- 本地持仓与自选：使用浏览器 `localStorage` 保存，**不会上传**。
