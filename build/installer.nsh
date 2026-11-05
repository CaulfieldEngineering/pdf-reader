; Register Readalong under "Open with" for .pdf files without taking over the
; default PDF handler: the app is added to the extension's OpenWithProgids
; list and to Applications, and the default (the extension's own value) is
; never touched. Per-user (HKCU), removed on uninstall.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Readalong.pdf" "" "PDF document (Readalong)"
  WriteRegStr HKCU "Software\Classes\Readalong.pdf\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Readalong.pdf\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "Readalong.pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Readalong.pdf"
  DeleteRegKey HKCU "Software\Classes\Readalong.pdf"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
