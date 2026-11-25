@echo off
chcp 65001 >nul
title WeFlow 微信 AI 助手 - 安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
