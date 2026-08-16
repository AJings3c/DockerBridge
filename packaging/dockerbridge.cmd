@echo off
setlocal
cd /d "%~dp0"

if not defined DOCKGE_DATA_DIR set "DOCKGE_DATA_DIR=.\data"
if not defined DOCKGE_STACKS_DIR set "DOCKGE_STACKS_DIR=.\stacks"

"%~dp0runtime\node.exe" "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0backend\index.ts" %*
