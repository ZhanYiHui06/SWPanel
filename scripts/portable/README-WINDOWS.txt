SWPanel Windows 便携版
======================

使用方法
  1. 解压整个文件夹（路径尽量不含中文和空格，例如 D:\SWPanel）。
  2. 双击 start.bat。浏览器会自动打开 http://127.0.0.1:3001/ 。
  3. 关闭 start.bat 的黑色窗口即停止服务。

无需安装 Node.js 和 Python：本包已自带。

自动建模需要（网页本身不需要）
  - 已安装并能正常启动的 SolidWorks。
  - 已安装 Codex CLI，并完成 codex login（用订阅额度），
    或在网页 设置 → Agent / API 中选择"使用 API Key"并填入密钥。
    切换认证方式后，需关闭并重新双击 start.bat 才生效。
  - 首次运行会把建模技能安装到 %USERPROFILE%\.agents\skills\solidworks-autobuild 。

数据位置
  默认保存在 %LOCALAPPDATA%\SWPanel\data（图纸、模型、数据库）。
  升级时只需替换本文件夹，数据不受影响。如需更改，运行前设置环境变量 SWPANEL_DATA_ROOT。

安全提示
  服务默认只监听本机（127.0.0.1），没有登录鉴权。
  不要把 HOST 改成 0.0.0.0 暴露到局域网，除非在受信任的内网。

常见问题
  - 端口被占用：运行前设置 PORT=3002 之类的环境变量。
  - 提示未找到 codex.exe：先安装 Codex CLI，或设置 SWPANEL_LIVE_CODEX_EXECUTABLE 指向 codex.exe 的完整路径。
