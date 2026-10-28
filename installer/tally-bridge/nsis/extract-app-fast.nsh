; Decode the full archive before replacing files. On a same-volume install,
; promote files by rename rather than writing/scanning the entire app twice.
; Existing destinations and other volumes retain the checked copy fallback.
!macro extractUsing7za FILE
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $R2 $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  SetOutPath "$PLUGINSDIR\7z-out"
  !insertmacro GajkesariStage "Unpacking the new connector..."
  Nsis7z::Extract "${FILE}"
  SetOutPath $R2
  IfFileExists "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" +3
    SetErrorLevel 2
    Abort "The connector could not be unpacked. Please run setup again."
  !insertmacro GajkesariStage "Installing the new connector..."
  FindFirst $R3 $R4 "$PLUGINSDIR\7z-out\*"
  ${DoWhile} $R4 != ""
    ${If} $R4 != "."
    ${AndIf} $R4 != ".."
      ClearErrors
      Rename "$PLUGINSDIR\7z-out\$R4" "$R2\$R4"
      ; Failed moves remain in staging for the copy fallback below.
    ${EndIf}
    ClearErrors
    FindNext $R3 $R4
  ${Loop}
  FindClose $R3
  StrCpy $R5 0
  ${Do}
    ClearErrors
    FindFirst $R3 $R4 "$PLUGINSDIR\7z-out\*"
    ${Do}
      ${If} $R4 != "."
      ${AndIf} $R4 != ".."
        ${ExitDo}
      ${EndIf}
      ClearErrors
      FindNext $R3 $R4
    ${Loop}
    FindClose $R3
    ${If} $R4 == ""
      ${ExitDo}
    ${EndIf}
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" "$R2"
    ${IfNot} ${Errors}
      ${ExitDo}
    ${EndIf}
    IntOp $R5 $R5 + 1
    ${If} $R5 >= 5
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Setup could not replace the connector files. Close the connector and try again." /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Abort
    ${EndIf}
    Sleep 1000
  ${Loop}
  !insertmacro GajkesariStage "Connector files installed"
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
!macroend
