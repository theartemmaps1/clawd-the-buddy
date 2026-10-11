; Clawd's installer: extra wizard pages on top of electron-builder's assisted installer.
;   Setup:     [Repair / Update / Uninstall, only when already installed] > Welcome > License
;              > Folder > "How should Clawd behave?" > Install > Finish
;   Uninstall: Welcome > "What to clean up?" > Uninstall > Finish
; Silent runs (/S) and automatic updates (--updated) skip every custom page.

!include nsDialogs.nsh
!include LogicLib.nsh

; ============================================================ setup
!macro customWelcomePage
  Var MaintMode
  Var MaintDlg
  Var MaintRepairRadio
  Var MaintRemoveRadio
  Var ExistingDir
  Var ExistingVer
  Var OptsShown
  Var OptStartupBox
  Var OptConnectBox
  Var OptStartupOn
  Var OptConnectOn

  ; ---- already installed? offer Repair / Update / Uninstall
  Function MaintenancePage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} ${Silent}
      Abort
    ${EndIf}
    ReadRegStr $ExistingDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $ExistingDir == ""
      Abort
    ${EndIf}
    ${IfNot} ${FileExists} "$ExistingDir\${APP_EXECUTABLE_FILENAME}"
      Abort
    ${EndIf}
    ReadRegStr $ExistingVer HKCU "${INSTALL_REGISTRY_KEY}" InstalledVersion
    ${If} $ExistingVer == ""
      StrCpy $ExistingVer "unknown version"
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Clawd is already installed" "Choose what you would like to do."
    nsDialogs::Create 1018
    Pop $MaintDlg
    ${If} $MaintDlg == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 26u "Clawd ($ExistingVer) is installed in:$\r$\n$ExistingDir"
    Pop $0

    ${If} $ExistingVer == "${VERSION}"
      StrCpy $1 "Repair Clawd  (reinstalls his program files; his memories and settings are kept)"
    ${Else}
      StrCpy $1 "Update Clawd to version ${VERSION}  (his memories and settings are kept)"
    ${EndIf}
    ${NSD_CreateRadioButton} 8u 36u 96% 22u "$1"
    Pop $MaintRepairRadio
    ${NSD_Check} $MaintRepairRadio

    ${NSD_CreateRadioButton} 8u 62u 96% 12u "Uninstall Clawd"
    Pop $MaintRemoveRadio

    nsDialogs::Show
  FunctionEnd

  Function MaintenanceLeave
    ${NSD_GetState} $MaintRemoveRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $MaintMode "uninstall"
      ; hand over to the uninstall wizard and close setup
      Exec '"$ExistingDir\${UNINSTALL_FILENAME}"'
      Quit
    ${EndIf}
    StrCpy $MaintMode "repair"
  FunctionEnd

  Function WelcomePre
    ; a repair goes straight to the files, no second welcome
    ${If} $MaintMode == "repair"
      Abort
    ${EndIf}
  FunctionEnd

  Page custom MaintenancePage MaintenanceLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePre
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---- after the folder page: two first-run choices
!macro customPageAfterChangeDir
  Function OptionsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} $MaintMode == "repair"
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "How should Clawd behave?" "You can change both of these later from his tray menu."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 6u 100% 12u "Start Clawd when Windows starts"
    Pop $OptStartupBox

    ${NSD_CreateCheckbox} 0 30u 100% 12u "Connect Clawd to Claude Code"
    Pop $OptConnectBox
    ${NSD_Check} $OptConnectBox
    ${NSD_CreateLabel} 12u 44u 94% 30u "Adds his hooks to your Claude Code settings.json so he can react to what Claude is doing. Your existing settings are kept, and a backup is made first."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function OptionsLeave
    StrCpy $OptsShown "1"
    ${NSD_GetState} $OptStartupBox $OptStartupOn
    ${NSD_GetState} $OptConnectBox $OptConnectOn
  FunctionEnd

  Page custom OptionsPage OptionsLeave
!macroend

!macro customInstall
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstalledVersion" "${VERSION}"

  ; Hand the two choices to Clawd. He applies them on his first start, then deletes the file.
  ${If} $OptsShown == "1"
    Push $0
    Push $1
    Push $2
    StrCpy $1 "false"
    StrCpy $2 "false"
    ${If} $OptStartupOn == ${BST_CHECKED}
      StrCpy $1 "true"
    ${EndIf}
    ${If} $OptConnectOn == ${BST_CHECKED}
      StrCpy $2 "true"
    ${EndIf}
    CreateDirectory "$APPDATA\claude-buddy"
    FileOpen $0 "$APPDATA\claude-buddy\install-options.json" w
    FileWrite $0 '{"startWithWindows":$1,"connectClaudeCode":$2}'
    FileClose $0
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; ============================================================ uninstall
!macro customUnWelcomePage
  Var UnDlg
  Var UnHooksBox
  Var UnDataBox
  Var UnDisconnect
  Var UnDeleteData

  Function un.OptionsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} ${Silent}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "What should be cleaned up?" "Clawd's program files are always removed."
    nsDialogs::Create 1018
    Pop $UnDlg
    ${If} $UnDlg == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 6u 100% 12u "Disconnect Clawd from Claude Code"
    Pop $UnHooksBox
    ${NSD_Check} $UnHooksBox
    ${NSD_CreateLabel} 12u 20u 94% 22u "Removes his hooks from settings.json so Claude Code doesn't keep calling someone who has left. Your other settings are kept."
    Pop $0

    ${NSD_CreateCheckbox} 0 52u 100% 12u "Also delete his memories, diary, photos and settings"
    Pop $UnDataBox
    ${NSD_CreateLabel} 12u 66u 94% 22u "This forgets everything Clawd has grown into and cannot be undone. Leave it unticked if you may reinstall him."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function un.OptionsLeave
    ${NSD_GetState} $UnHooksBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $UnDisconnect "1"
    ${Else}
      StrCpy $UnDisconnect "0"
    ${EndIf}
    ${NSD_GetState} $UnDataBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $UnDeleteData "1"
    ${EndIf}
  FunctionEnd

  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.OptionsPage un.OptionsLeave
!macroend

!macro customUnInstall
  ; Not for the silent uninstall that an update runs first: updates keep everything.
  ${IfNot} ${isUpdated}
    ${If} $UnDisconnect != "0"
      ; run his bundled script with the app's own runtime, as plain Node, no window
      System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
      nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\disconnect-hooks.js"'
      Pop $0
      System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")'
    ${EndIf}
    ${If} $UnDeleteData == "1"
      RMDir /r "$APPDATA\claude-buddy"
    ${EndIf}
  ${EndIf}
!macroend
