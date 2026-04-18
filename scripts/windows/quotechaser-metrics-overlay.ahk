#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; Compact Windows overlay for Quote Chaser + Quote Follow Up.
; 1. Install AutoHotkey v2 on your Windows PC.
; 2. Save this file anywhere.
; 3. Double-click it to show a small always-on-top overlay.
; 4. Press Ctrl+Alt+R to refresh, Ctrl+Alt+O to snap back to the top-right, Ctrl+Alt+Q to close.

PRODUCTS := [
    Map("name", "Quote Chaser", "label", "QUOTE CHASER", "url", "https://quotechaser.online/api/project-metrics", "accent", "8B95FF"),
    Map("name", "Quote Follow Up", "label", "QUOTE FOLLOW UP", "url", "https://quotefollowup.online/api/project-metrics", "accent", "5EEAD4")
]
REFRESH_MS := 30000
WINDOW_WIDTH := 188
MARGIN_RIGHT := 20
MARGIN_TOP := 20
WINDOW_OPACITY := 220

controls := []
overlayGui := Gui("+AlwaysOnTop -Caption +ToolWindow +Border", "Metrics Overlay")
overlayGui.BackColor := "111418"
overlayGui.SetFont("s8 cFFFFFF", "Segoe UI")
overlayGui.MarginX := 12
overlayGui.MarginY := 10

for index, product in PRODUCTS {
    gap := (index = 1) ? 0 : 14

    overlayGui.SetFont("s8 bold c" product["accent"], "Segoe UI Semibold")
    overlayGui.AddText("xm y+" gap, product["label"])
    statusDot := overlayGui.AddText("x+6 yp+1 c6EE7B7", "●")

    overlayGui.SetFont("s8 c7D8799", "Segoe UI")
    overlayGui.AddText("xm y+7", "L")
    overlayGui.SetFont("s12 bold cFFFFFF", "Segoe UI Semibold")
    liveUsersValue := overlayGui.AddText("x+4 yp-3 w24", "--")

    overlayGui.SetFont("s8 c7D8799", "Segoe UI")
    overlayGui.AddText("x+12 yp+3", "S")
    overlayGui.SetFont("s12 bold cFFFFFF", "Segoe UI Semibold")
    signupsValue := overlayGui.AddText("x+4 yp-3 w24", "--")

    controls.Push(Map(
        "name", product["name"],
        "url", product["url"],
        "statusDot", statusDot,
        "liveUsersValue", liveUsersValue,
        "signupsValue", signupsValue
    ))
}

overlayGui.SetFont("s7 c7F8A9D", "Segoe UI")
updatedText := overlayGui.AddText("xm y+14 w160", "Waiting for first refresh")
overlayGui.SetFont("s7 c5E687A", "Segoe UI")
helperText := overlayGui.AddText("xm y+4 w160", "30s poll  •  Ctrl+Alt+R refresh")

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
    global controls, updatedText
    hadFailure := false

    for _, control in controls {
        try {
            metrics := FetchMetrics(control["url"])
            control["liveUsersValue"].Text := metrics["liveUsers"]
            control["signupsValue"].Text := metrics["signupsToday"]
            control["statusDot"].Opt("c6EE7B7")
        } catch as err {
            hadFailure := true
            control["liveUsersValue"].Text := "--"
            control["signupsValue"].Text := "--"
            control["statusDot"].Opt("cFCA5A5")
        }
    }

    if (hadFailure) {
        updatedText.Text := "Refresh issue, retrying"
    } else {
        updatedText.Text := "Updated " FormatTime(A_Now, "HH:mm:ss")
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
