#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; Lightweight Windows overlay for Quote Chaser + Quote Follow Up.
; 1. Install AutoHotkey v2 on your Windows PC.
; 2. Save this file anywhere.
; 3. Double-click it to show a small always-on-top overlay.
; 4. Press Ctrl+Alt+R to refresh, Ctrl+Alt+O to snap back to the top-right, Ctrl+Alt+Q to close.

PRODUCTS := [
    Map("name", "Quote Chaser", "label", "QUOTE CHASER", "url", "https://quotechaser.online/api/project-metrics", "accent", "8B95FF"),
    Map("name", "Quote Follow Up", "label", "QUOTE FOLLOW UP", "url", "https://quotefollowup.online/api/project-metrics", "accent", "5EEAD4")
]
REFRESH_MS := 30000
WINDOW_WIDTH := 236
MARGIN_RIGHT := 24
MARGIN_TOP := 24
WINDOW_OPACITY := 220

controls := []
overlayGui := Gui("+AlwaysOnTop -Caption +ToolWindow +Border", "Metrics Overlay")
overlayGui.BackColor := "111418"
overlayGui.SetFont("s9 cFFFFFF", "Segoe UI")
overlayGui.MarginX := 14
overlayGui.MarginY := 12

for index, product in PRODUCTS {
    gap := (index = 1) ? 0 : 20
    overlayGui.SetFont("s9 bold c" product["accent"], "Segoe UI Semibold")
    overlayGui.AddText("xm y+" gap, product["label"])
    statusDot := overlayGui.AddText("x+m yp c6EE7B7", "●")
    statusText := overlayGui.AddText("x+m yp w112 cAAB4C5", "Connecting")

    overlayGui.SetFont("s8 c7D8799", "Segoe UI")
    overlayGui.AddText("xm y+12", "LIVE USERS")
    overlayGui.AddText("xm y+18", "SIGNUPS TODAY")

    overlayGui.SetFont("s19 bold cFFFFFF", "Segoe UI Semibold")
    liveUsersValue := overlayGui.AddText("x158 y+0 w56 Right", "--")
    signupsValue := overlayGui.AddText("xp y+18 w56 Right", "--")

    overlayGui.SetFont("s8 c7F8A9D", "Segoe UI")
    updatedText := overlayGui.AddText("xm y+18 w206", "Waiting for first refresh")

    controls.Push(Map(
        "name", product["name"],
        "url", product["url"],
        "statusDot", statusDot,
        "statusText", statusText,
        "liveUsersValue", liveUsersValue,
        "signupsValue", signupsValue,
        "updatedText", updatedText
    ))
}

overlayGui.SetFont("s8 c5E687A", "Segoe UI")
helperText := overlayGui.AddText("xm y+16 w206", "Ctrl+Alt+R refresh  •  Ctrl+Alt+Q close")

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
    global controls

    for _, control in controls {
        try {
            metrics := FetchMetrics(control["url"])
            control["liveUsersValue"].Text := metrics["liveUsers"]
            control["signupsValue"].Text := metrics["signupsToday"]
            control["updatedText"].Text := "Updated " FormatTime(A_Now, "HH:mm:ss")
            control["statusDot"].Opt("c6EE7B7")
            control["statusText"].Opt("cAAB4C5")
            control["statusText"].Text := "Live"
        } catch as err {
            control["updatedText"].Text := "Refresh failed, retrying"
            control["statusDot"].Opt("cFCA5A5")
            control["statusText"].Opt("cF3B3B3")
            control["statusText"].Text := "Offline"
        }
    }
}

FetchMetrics(url) {
    request := ComObject("WinHttp.WinHttpRequest.5.1")
    request.Open("GET", url, false)
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

    return Map("liveUsers", liveUsers, "signupsToday", signupsToday)
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
