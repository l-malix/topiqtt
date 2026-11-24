package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var appVersion = "0.1.0"

//go:embed ui/*
var uiFS embed.FS

func showNativeErrorBox(title, text string) {
	u32 := windows.NewLazySystemDLL("user32.dll")
	msgBox := u32.NewProc("MessageBoxW")
	tPtr, _ := windows.UTF16PtrFromString(title)
	mPtr, _ := windows.UTF16PtrFromString(text)
	const mbIconError = 0x00000010
	_, _, _ = msgBox.Call(0, uintptr(unsafe.Pointer(mPtr)), uintptr(unsafe.Pointer(tPtr)), mbIconError)
}

type openFileNameW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

func pickCertFileNative(hwnd uintptr, title string) (string, error) {
	comdlg := windows.NewLazySystemDLL("comdlg32.dll")
	getOpenFileName := comdlg.NewProc("GetOpenFileNameW")
	commDlgExtErr := comdlg.NewProc("CommDlgExtendedError")

	const (
		ofnPathMustExist = 0x00000800
		ofnFileMustExist = 0x00001000
		ofnNoChangeDir   = 0x00000008
	)

	filter := utf16.Encode([]rune("Certificats et clés (*.pem;*.crt;*.cer;*.key)\x00*.pem;*.crt;*.cer;*.key\x00Tous les fichiers (*.*)\x00*.*\x00\x00"))
	fileBuf := make([]uint16, 4096)
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return "", err
	}

	ofn := openFileNameW{
		lStructSize:  uint32(unsafe.Sizeof(openFileNameW{})),
		hwndOwner:    hwnd,
		lpstrFilter:  &filter[0],
		nFilterIndex: 1,
		lpstrFile:    &fileBuf[0],
		nMaxFile:     uint32(len(fileBuf)),
		lpstrTitle:   titlePtr,
		flags:        ofnPathMustExist | ofnFileMustExist | ofnNoChangeDir,
	}

	ret, _, _ := getOpenFileName.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		extErr, _, _ := commDlgExtErr.Call()
		if extErr == 0 {
			return "", nil
		}
		return "", fmt.Errorf("Impossible d'ouvrir le sélecteur de fichier (code 0x%X).", extErr)
	}
	return windows.UTF16ToString(fileBuf), nil
}

func buildDesktopHTML() (string, error) {
	htmlBytes, err := uiFS.ReadFile("ui/index.html")
	if err != nil {
		return "", err
	}
	cssBytes, err := uiFS.ReadFile("ui/styles.css")
	if err != nil {
		return "", err
	}
	jsBytes, err := uiFS.ReadFile("ui/app.js")
	if err != nil {
		return "", err
	}

	page := string(htmlBytes)
	page = strings.Replace(page, "<!--TOPIQTT_STYLE-->", "<style>\n"+string(cssBytes)+"\n</style>", 1)
	page = strings.Replace(page, "<!--TOPIQTT_SCRIPT-->", "<script>\n"+string(jsBytes)+"\n</script>", 1)
	return page, nil
}

func isPortReachable(host string, port int, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func main() {
	store, err := NewStore("")
	if err != nil {
		store = &Store{
			path: filepath.Join(defaultConfigDir(), "state.json"),
			data: defaultPersistedState(),
		}
	}

	webViewDataPath, mkErr := os.MkdirTemp("", "topiqtt-wv2-*")
	if mkErr != nil {
		webViewDataPath = filepath.Join(defaultConfigDir(), fmt.Sprintf("webview2-%d", os.Getpid()))
		_ = os.MkdirAll(webViewDataPath, 0o755)
	}
	defer os.RemoveAll(webViewDataPath)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		DataPath:  webViewDataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "TopiQTT",
			Width:  1320,
			Height: 840,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		showNativeErrorBox(
			"TopiQTT — Composant manquant",
			"Microsoft Edge WebView2 Runtime est requis pour exécuter TopiQTT.\n\nInstallez WebView2 Runtime depuis le site officiel Microsoft puis relancez l'application.",
		)
		return
	}
	defer w.Destroy()
	w.SetTitle("TopiQTT")
	w.SetSize(960, 620, webview2.HintMin)

	var mgr *MqttManager
	mgr = NewMqttManager(store, func() {
		snap := mgr.Snapshot()
		raw, err := json.Marshal(snap)
		if err != nil {
			return
		}
		payload := string(raw)
		w.Dispatch(func() {
			w.Eval("window.__topiqttOnSnapshot && window.__topiqttOnSnapshot(" + payload + ");")
		})
	})
	defer mgr.Close()

	_ = w.Bind("apiBootstrap", func() AppSnapshot {
		return mgr.Snapshot()
	})

	_ = w.Bind("apiConnect", func(p BrokerProfile) (AppSnapshot, error) {
		_ = store.UpsertProfile(p)
		err := mgr.Connect(p)
		return mgr.Snapshot(), err
	})

	_ = w.Bind("apiDisconnect", func() AppSnapshot {
		mgr.Disconnect()
		return mgr.Snapshot()
	})

	_ = w.Bind("apiDeleteProfile", func(id string) (PersistedState, error) {
		if mgr.Snapshot().Status.BrokerID == id {
			mgr.Disconnect()
		}
		err := store.DeleteProfile(id)
		return store.Snapshot(), err
	})

	_ = w.Bind("apiTestConnection", func(p BrokerProfile) TestConnectionResult {
		return mgr.TestConnection(p)
	})

	_ = w.Bind("apiPublish", func(topic string, payload string, qos int, retain bool) (AppSnapshot, error) {
		err := mgr.Publish(topic, payload, byte(qos), retain)
		return mgr.Snapshot(), err
	})

	_ = w.Bind("apiClearTopics", func(topics []string) (AppSnapshot, error) {
		err := mgr.ClearTopics(topics)
		return mgr.Snapshot(), err
	})

	_ = w.Bind("apiSetPaused", func(paused bool) AppSnapshot {
		mgr.SetPaused(paused)
		return mgr.Snapshot()
	})

	_ = w.Bind("apiSavePinned", func(brokerID string, pinned []string) error {
		return store.SetPinned(brokerID, pinned)
	})

	_ = w.Bind("apiSaveDashboards", func(brokerID string, dashes []DashboardConfig, activeDashID string) error {
		return store.SaveDashboards(brokerID, dashes, activeDashID)
	})

	_ = w.Bind("apiSavePrefs", func(prefs UIPrefs) error {
		return store.SavePrefs(prefs)
	})

	_ = w.Bind("apiPickCertFile", func(reqID string, kind string) {
		title := "Sélectionner un fichier"
		switch kind {
		case "ca":
			title = "Sélectionner le certificat d'autorité (CA)"
		case "clientCert":
			title = "Sélectionner le certificat client"
		case "clientKey":
			title = "Sélectionner la clé privée client"
		}
		w.Dispatch(func() {
			path, pickErr := pickCertFileNative(uintptr(w.Window()), title)
			errMsg := ""
			if pickErr != nil {
				errMsg = pickErr.Error()
			}
			payload, _ := json.Marshal(struct {
				ReqID string `json:"reqId"`
				Path  string `json:"path"`
				Error string `json:"error"`
			}{
				ReqID: reqID,
				Path:  path,
				Error: errMsg,
			})
			w.Eval("window.__topiqttResolveCertPick && window.__topiqttResolveCertPick(" + string(payload) + ");")
		})
	})

	// Auto-connect if an active saved profile exists (check reachability first for local hosts)
	snap := store.Snapshot()
	for _, p := range snap.Profiles {
		if p.ID == snap.ActiveBrokerID {
			if (p.Host == "localhost" || p.Host == "127.0.0.1") && !isPortReachable(p.Host, p.Port, 250*time.Millisecond) {
				break
			}
			_ = mgr.Connect(p)
			break
		}
	}

	html, err := buildDesktopHTML()
	if err != nil {
		showNativeErrorBox("TopiQTT — Erreur interne", err.Error())
		return
	}
	w.SetHtml(html)
	w.Run()
}
