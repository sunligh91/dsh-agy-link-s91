@echo off
rem Windows shim for the offline fake agy CLI used by the test suite.
rem
rem Node cannot spawn a .mjs directly on Windows: CreateProcess has no file
rem association for the extension and does not honour the shebang, so the
rem spawn fails with EFTYPE. Routing through cmd.exe mirrors how a real
rem agy.cmd install is launched (src/host/runner.ts detects .cmd shims and
rem wraps them in ComSpec), so the same code path is exercised.
node "%~dp0fake-agy.mjs" %*
