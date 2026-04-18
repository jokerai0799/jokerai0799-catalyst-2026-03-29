#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; Quote Chaser desktop overlay for Windows.
; 1. Install AutoHotkey v2 on your home PC.
; 2. Save this file anywhere.
; 3. Double-click it to show a lightweight always-on-top overlay.
; 4. Press Ctrl+Alt+R to refresh, Ctrl+Alt+O to snap back to the top-right, Ctrl+Alt+Q to close.

API_URL := "https://quotechaser.online/api/project-metrics"
REFRESH_MS := 30000
WINDOW_WIDTH := 220
MARGIN_RIGHT := 24
MARGIN_TOP := 24
WINDOW_OPACITY := 220

overlayGui := Gui("+AlwaysOnTop -Caption +ToolWindow +Border", "Quote Chaser Overlay")
overlayGui.BackColor := "111418"
overlayGui.SetFont("s9 cFFFFFF", "Segoe UI")
overlayGui.MarginX := 14
overlayGui.MarginY := 12

brandText := overlayGui.AddText("xm ym c8B95FF", "QUOTE CHASER")
statusDot := overlayGui.AddText("x+m yp c6EE7B7", "●")
statusText := overlayGui.AddText("x+m yp w120 cAAB4C5", "Connecting")

overlayGui.SetFont("s8 c7D8799", "Segoe UI")
overlayGui.AddText("xm y+14", "LIVE USERS")
overlayGui.AddText("xm y+18", "SIGNUPS TODAY")

overlayGui.SetFont("s20 bold cFFFFFF", "Segoe UI Semibold")
liveUsersValue := overlayGui.AddText("x150 y+0 w56 Right", "--")
signupsValue := overlayGui.AddText("xp y+20 w56 Right", "--")

overlayGui.SetFont("s8 c7F8A9D", "Segoe UI")
updatedText := overlayGui.AddText("xm y+20 w190", "Waiting for first refresh")
helperText := overlayGui.AddText("xm y+8 w190 c5E687A", "Ctrl+Alt+R refresh  •  Ctrl+Alt+Q close")

overlayGui.Show("NA AutoSize")
WinSetTransparent(WINDOW_OPACITY, "ahk_id " overlayGui.Hwnd)
PositionOverlay()
OnMessage(0x201, StartWindowDrag)

^!r::RefreshMetrics()
^!o::PositionOverlay()
^!q::ExitApp()

SetTimer(RefreshMetrics, REFRESH_MS)
RefreshMetrics()

RefreshMetrics(*) {
    global API_URL, liveUsersValue, signupsValue, updatedText, statusDot, statusText

    try {
        request := ComObject("WinHttp.WinHttpRequest.5.1")
        request.Open("GET", API_URL, false)
        request.SetRequestHeader("Accept", "application/json")
        request.SetTimeouts(4000, 4000, 4000, 4000)
        request.Send()

        if (request.Status != 200) {
            throw Error("HTTP " request.Status)
        }

        json := request.ResponseText
        liveUsers := ExtractInt(json, "liveUsers")
        signupsToday := ExtractInt(json, "signupsToday")

        if (liveUsers = "" || signupsToday = "") {
            throw Error("Could not read metrics")
        }

        liveUsersValue.Text := liveUsers
        signupsValue.Text := signupsToday
        updatedText.Text := "Updated " FormatTime(A_Now, "HH:mm:ss")
        statusDot.Opt("c6EE7B7")
        statusText.Text := "Live"
        statusText.Opt("cAAB4C5")
    } catch as err {
        updatedText.Text := "Refresh failed, retrying"
        statusDot.Opt("cFCA5A5")
        statusText.Text := "Offline"
        statusText.Opt("cF3B3B3")
    }
}

ExtractInt(json, key) {
    pattern := '"' key '"\s*:\s*(\d+)'
    if RegExMatch(json, pattern, &match) {
        return match[1]
    }
    return ""
}

PositionOverlay(*) {
    global overlayGui, WINDOW_WIDTH, MARGIN_RIGHT, MARGIN_TOP

    MonitorGetWorkArea(1, &left, &top, &right, &bottom)
    x := right - WINDOW_WIDTH - MARGIN_RIGHT
    y := top + MARGIN_TOP
    overlayGui.Show("NA AutoSize x" x " y" y)
}

StartWindowDrag(wParam, lParam, msg, hwnd) {
    global overlayGui
    if (hwnd != overlayGui.Hwnd) {
        return
    }
    PostMessage(0xA1, 2,,, "ahk_id " hwnd)
}
