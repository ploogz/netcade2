; Netcade installer additions (included by electron-builder's NSIS script).
; Dolphin needs the Microsoft Visual C++ 2015-2022 x64 runtime. Most PCs already have a recent
; one; if not, install the copy bundled in the installer (one Windows permission prompt).

!macro customInstall
  StrCpy $1 "$INSTDIR\resources\vendor\vc_redist.x64.exe"
  IfFileExists "$1" 0 vc_done

  SetRegView 64
  ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $3 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
  SetRegView lastused
  StrCmp $2 "1" 0 vc_install
  IntCmp $3 34433 vc_cleanup vc_install vc_cleanup

  vc_install:
    DetailPrint "Installing the Microsoft Visual C++ runtime used by Dolphin..."
    ExecShellWait "runas" "$1" "/install /quiet /norestart"

  vc_cleanup:
    Delete "$1"

  vc_done:
!macroend
