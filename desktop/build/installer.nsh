; installer.nsh — WG Companion 自定义安装步骤（桌面 / 开始菜单快捷方式）
;
; 作用：
;   1) 在「选择安装目录」页之后插入「快捷方式选择页」，让用户自行决定是否创建
;      【桌面快捷方式】与【开始菜单快捷方式】。
;   2) 安装段按用户选择创建对应快捷方式。
;   3) 卸载段同步清理这些快捷方式（内置快捷方式创建已关闭，需手动删除）。
;
; 健壮性要点（重要）：
;   · 勾选状态默认值在 customInit 里预置为 "1"。这样即使在「静默安装」或自定义页
;     未显示的情况下，快捷方式也一定会被创建 —— 不会出现「装完什么都没有」。
;   · 勾选状态在页面 **leave 回调**（Page custom <page> <leave>）里读取。此时对话框
;     仍然存在，控件句柄有效；若放在 nsDialogs::Show 之后，某些情况下句柄已失效，
;     读回的会是空值，从而静默地不创建任何快捷方式。
;   · 安装段用 `!= 0` 判断（而不是 `== 1`），空值同样视为「创建」，行为可预期。
;
; 本文件由 electron-builder 注入到 sharedHeader（先于模板展开），因此：
;   · 用到 nsDialogs 的页面函数必须定义在 customPageAfterChangeDir 宏体内，
;     该宏在模板 MUI2 之后展开，届时 nsDialogs 宏已可用。

!macro customInit
  ; 默认「创建」：页面未显示 / 静默安装 / 用户未改动时都会创建快捷方式
  StrCpy $desktopChk "1"
  StrCpy $startMenuChk "1"
!macroend

!macro customPageAfterChangeDir
  Var /GLOBAL desktopChk
  Var /GLOBAL startMenuChk
  Var desktopChkHwnd
  Var startMenuChkHwnd

  ; 第三个参数是 leave 回调：在对话框销毁前读取勾选状态
  Page custom ShortcutChoicePage ShortcutChoicePageLeave

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
    ; ⚠️ 与 "0" 做**字符串**比较：空值（变量未初始化）同样视为「创建」，
    ;    避免 NSIS 把空串按整数 0 处理而导致静默地不创建任何快捷方式。
    ${If} $desktopChk != "0"
      ${NSD_Check} $desktopChkHwnd
    ${EndIf}

    ${NSD_CreateCheckbox} 0 60u 100% 16u "创建开始菜单快捷方式(&M)"
    Pop $startMenuChkHwnd
    ${If} $startMenuChk != "0"
      ${NSD_Check} $startMenuChkHwnd
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  ; leave 回调：对话框尚在，句柄有效
  Function ShortcutChoicePageLeave
    ${NSD_GetState} $desktopChkHwnd $desktopChk
    ${NSD_GetState} $startMenuChkHwnd $startMenuChk
  FunctionEnd
!macroend

!macro customInstall
  ; ⚠️ 一律用字符串比较（见上）：只有明确取消勾选（"0"）才跳过创建
  ${If} $desktopChk != "0"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
  ${EndIf}
  ${If} $startMenuChk != "0"
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
