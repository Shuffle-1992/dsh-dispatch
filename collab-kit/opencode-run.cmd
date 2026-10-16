@echo off
rem Single-token launcher for hooks / the dispatch panel (internal path may contain spaces).
rem Usage: opencode-run.cmd --prompt "Reply with exactly: PONG" --tag oc-smoke
rem This is the Windows shim for the OpenCode executor (collab-kit/opencode-run.mjs),
rem same pattern as zcode-run.cmd: resolve paths relative to this file via %~dp0.
rem NOTE: keep this file ASCII-only. Non-ASCII bytes in rem lines make cmd.exe echo
rem "'xxx' is not recognized as an internal or external command" noise (harmless but confusing).
node "%~dp0opencode-run.mjs" %*
exit /b %ERRORLEVEL%
