; NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; "Open in NeuraOS" on folders in Explorer (roadmap 5.4): right-click a folder,
; or the empty space inside one, and the app opens with that folder as its
; working folder. Per-user keys (HKCU) so no elevation is needed, removed again
; on uninstall. The .gguf association is the bundle's own (fileAssociations).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\NeuraOS" "" "Open in NeuraOS"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NeuraOS" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NeuraOS\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NeuraOS" "" "Open in NeuraOS"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NeuraOS" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NeuraOS\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NeuraOS"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NeuraOS"
!macroend
