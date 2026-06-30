$ErrorActionPreference = "Stop"
$env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
npx tauri build
