; installer.nsh — WG Companion 自定义安装步骤
;
; 作用：
;   1) 在「选择安装目录」页之后，插入一个「快捷方式选择页」，让用户在安装结束前
;      自行决定是否创建【桌面快捷方式】与【开始菜单快捷方式】（均可留空）。
;   2) 安装段按用户选择创建对应快捷方式。
;   3) 卸载段同步清理这些快捷方式（由于内置快捷方式创建已被关闭，需手动删除）。
;
; 注意：本文件由 electron-builder 注入到 sharedHeader，早于模板中的 MUI2.nsh 被编译，
; 因此用到 nsDialogs 的页面函数必须定义在 customPageAfterChangeDir 宏体内，
; 该宏在模板（MUI2 之后）的第 43 行展开，届时 nsDialogs 宏已可用。

!macro customPageAfterChangeDir
  ; 全局变量（在模板顶层展开，合法）
  Var desktopChk
  Var startMenuChk
  Var desktopChkHwnd
  Var startMenuChkHwnd

  ; 在「目录选择页」与「安装页」之间插入自定义页
  Page custom ShortcutChoicePage

  Function ShortcutChoicePage
    nsDialogs::Create 1018
    Pop $R0
    ${If} $R0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "请选择要创建的快捷方式（均可不勾选）："
    Pop $R1

    ${NSD_CreateCheckbox} 0 36u 100% 16u "创建桌面快捷方式(&D)"
    Pop $desktopChkHwnd
    ${NSD_Check} $desktopChkHwnd

    ${NSD_CreateCheckbox} 0 60u 100% 16u "创建开始菜单快捷方式(&M)"
    Pop $startMenuChkHwnd
    ${NSD_Check} $startMenuChkHwnd

    nsDialogs::Show

    ; 页面关闭后读取勾选状态（1=勾选，0=未勾选）
    ${NSD_GetState} $desktopChkHwnd $desktopChk
    ${NSD_GetState} $startMenuChkHwnd $startMenuChk
  FunctionEnd
!macroend

!macro customInstall
  ${If} $desktopChk == 1
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
  ${EndIf}
  ${If} $startMenuChk == 1
    ${StdUtils.GetParentPath} $R5 "$newStartMenuLink"
    CreateDirectory "$R5"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0
  ${EndIf}
!macroend

!macro customUnInstall
  WinShell::UninstAppUserModelId "${APP_ID}"
  Delete "$oldDesktopLink"
  Delete "$oldStartMenuLink"
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory
  ${IfNot} $R1 == ""
    RMDir "$SMPROGRAMS\$R1"
  ${EndIf}
!macroend
