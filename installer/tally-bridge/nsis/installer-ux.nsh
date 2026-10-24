!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Set up your Tally connector"
!define MUI_WELCOMEPAGE_TEXT "Connect Gajkesari to the Tally company on this computer.$\r$\n$\r$\nSetup will close any running connector before installing the new version. Please finish any Tally work first.$\r$\n$\r$\nYour saved connection and local data will be kept.$\r$\n$\r$\nClick Install to begin."
!define MUI_INSTFILESPAGE_HEADER_TEXT "Installing your connector"
!define MUI_INSTFILESPAGE_HEADER_SUBTEXT "Please wait while setup prepares the new version."
!define MUI_FINISHPAGE_TITLE "Your connector is ready"
!define MUI_FINISHPAGE_TEXT "Gajkesari Tally Connector has been installed successfully.$\r$\n$\r$\nChoose whether to open it now, then click Finish."
!define MUI_FINISHPAGE_RUN_TEXT "Open Gajkesari Tally Connector"
!define MUI_FINISHPAGE_NOAUTOCLOSE

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW GajkesariWelcomeShown
  !insertmacro MUI_PAGE_WELCOME
  Function GajkesariWelcomeShown
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 0x000C 0 "STR:Install"
  FunctionEnd
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro GajkesariFindProcess
  nsExec::Exec /TIMEOUT=10000 `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
!macroend

!macro GajkesariStopProcess FORCE
  nsExec::Exec /TIMEOUT=10000 `"$SYSDIR\cmd.exe" /C taskkill ${FORCE} /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
  Pop $R0
!macroend

!macro customCheckAppRunning
  ; Native Windows tools match the exact connector executable for the current
  ; user, covering both old and new folders without slow PowerShell startup.
  StrCpy $IsPowerShellAvailable "1"
  !ifdef BUILD_UNINSTALLER
    !insertmacro _CHECK_APP_RUNNING
  !else
    Call GajkesariCloseRunningConnectors
  !endif
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !include "getProcessInfo.nsh"
    Var pid
  !endif
  Var IsPowerShellAvailable
  SetFont "Segoe UI" 9
  BrandingText "Gajkesari"
  !ifndef BUILD_UNINSTALLER
    Function GajkesariCloseRunningConnectors
      !insertmacro GajkesariFindProcess
      ${If} $R0 == 0
        DetailPrint "Closing the running Gajkesari connector..."
        !insertmacro GajkesariStopProcess ""
        Sleep 500
        !insertmacro GajkesariFindProcess
        ${If} $R0 == 0
          !insertmacro GajkesariStopProcess "/F"
          Sleep 500
          !insertmacro GajkesariFindProcess
          ${If} $R0 == 0
            MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not close the connector. Close it, then run setup again." /SD IDOK
            Abort
          ${EndIf}
        ${EndIf}
      ${EndIf}
    FunctionEnd

  !endif
!macroend
