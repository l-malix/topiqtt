package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// BrokerProfile defines a saved MQTT connection.
type BrokerProfile struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Proto              string `json:"proto"` // mqtt | mqtts | ws | wss
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	ClientID           string `json:"clientId"`
	Subscription       string `json:"subscription"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify"`
	CACertPath         string `json:"caCertPath"`
	ClientCertPath     string `json:"clientCertPath"`
	ClientKeyPath      string `json:"clientKeyPath"`
	Color              string `json:"color"`
}

// SeriesConfig describes one plotted MQTT topic/field curve on a chart.
type SeriesConfig struct {
	Topic  string `json:"topic"`
	Field  string `json:"field"`
	Label  string `json:"label"`
	Color  string `json:"color"`
	Hidden bool   `json:"hidden"`
}

// ChartConfig describes a single multi-curve chart card on a dashboard.
type ChartConfig struct {
	ID     string         `json:"id"`
	Title  string         `json:"title"`
	Span   int            `json:"span"`   // 1 or 2
	Height int            `json:"height"` // 180 | 240 | 320
	Scale  string         `json:"scale"`  // raw | normalized
	Series []SeriesConfig `json:"series"`
}

// DashboardConfig groups user-created multi-curve charts.
type DashboardConfig struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Charts []ChartConfig `json:"charts"`
}

// UIPrefs stores user interface preferences persisted across launches.
type UIPrefs struct {
	Theme         string `json:"theme"` // auto | light | dark
	SidebarWidth  int    `json:"sidebarWidth"`
	PublishHeight int    `json:"publishHeight"`
	PublishOpen   bool   `json:"publishOpen"`
}

// PersistedState is serialized to %APPDATA%\TopiQTT\state.json.
type PersistedState struct {
	ActiveBrokerID string                       `json:"activeBrokerId"`
	Profiles       []BrokerProfile              `json:"profiles"`
	PinnedByBroker map[string][]string          `json:"pinnedByBroker"`
	Dashboards     map[string][]DashboardConfig `json:"dashboardsByBroker"`
	ActiveDashID   map[string]string            `json:"activeDashByBroker"`
	Prefs          UIPrefs                      `json:"prefs"`
}

// Store handles thread-safe loading and atomic saving of application state.
type Store struct {
	mu   sync.Mutex
	path string
	data PersistedState
}

func defaultConfigDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = "."
	}
	return filepath.Join(base, "TopiQTT")
}

func defaultPersistedState() PersistedState {
	return PersistedState{
		ActiveBrokerID: "",
		Profiles:       []BrokerProfile{},
		PinnedByBroker: map[string][]string{},
		Dashboards:     map[string][]DashboardConfig{},
		ActiveDashID:   map[string]string{},
		Prefs: UIPrefs{
			Theme:         "auto",
			SidebarWidth:  360,
			PublishHeight: 260,
			PublishOpen:   false,
		},
	}
}

// NewStore opens or initializes the persisted JSON state file at path.
func NewStore(path string) (*Store, error) {
	if path == "" {
		path = filepath.Join(defaultConfigDir(), "state.json")
	}
	s := &Store{
		path: path,
		data: defaultPersistedState(),
	}
	if err := s.load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var parsed PersistedState
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return err
	}
	// Migrate away from old mock demo profile if present
	if parsed.Profiles != nil {
		filtered := make([]BrokerProfile, 0, len(parsed.Profiles))
		for _, p := range parsed.Profiles {
			if p.Proto != "demo" {
				filtered = append(filtered, p)
			}
		}
		s.data.Profiles = filtered
	}
	if parsed.ActiveBrokerID != "demo" {
		s.data.ActiveBrokerID = parsed.ActiveBrokerID
	}
	if len(s.data.Profiles) == 0 {
		s.data.ActiveBrokerID = ""
	}
	if parsed.PinnedByBroker != nil {
		s.data.PinnedByBroker = parsed.PinnedByBroker
	}
	if parsed.Dashboards != nil {
		s.data.Dashboards = parsed.Dashboards
	}
	if parsed.ActiveDashID != nil {
		s.data.ActiveDashID = parsed.ActiveDashID
	}
	if parsed.Prefs.Theme != "" {
		s.data.Prefs = parsed.Prefs
	}
	return nil
}

func (s *Store) saveLocked() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) Snapshot() PersistedState {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := json.Marshal(s.data)
	var copyState PersistedState
	_ = json.Unmarshal(raw, &copyState)
	return copyState
}

func (s *Store) UpsertProfile(p BrokerProfile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for i := range s.data.Profiles {
		if s.data.Profiles[i].ID == p.ID {
			s.data.Profiles[i] = p
			found = true
			break
		}
	}
	if !found {
		s.data.Profiles = append(s.data.Profiles, p)
	}
	s.data.ActiveBrokerID = p.ID
	return s.saveLocked()
}

func (s *Store) DeleteProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make([]BrokerProfile, 0, len(s.data.Profiles))
	for _, p := range s.data.Profiles {
		if p.ID != id {
			next = append(next, p)
		}
	}
	s.data.Profiles = next
	if s.data.ActiveBrokerID == id {
		if len(next) > 0 {
			s.data.ActiveBrokerID = next[0].ID
		} else {
			s.data.ActiveBrokerID = ""
		}
	}
	return s.saveLocked()
}

func (s *Store) SetActiveBroker(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.ActiveBrokerID = id
	return s.saveLocked()
}

func (s *Store) SetPinned(brokerID string, pinned []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.PinnedByBroker == nil {
		s.data.PinnedByBroker = map[string][]string{}
	}
	s.data.PinnedByBroker[brokerID] = pinned
	return s.saveLocked()
}

func (s *Store) SaveDashboards(brokerID string, dashes []DashboardConfig, activeDashID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Dashboards == nil {
		s.data.Dashboards = map[string][]DashboardConfig{}
	}
	if s.data.ActiveDashID == nil {
		s.data.ActiveDashID = map[string]string{}
	}
	s.data.Dashboards[brokerID] = dashes
	s.data.ActiveDashID[brokerID] = activeDashID
	return s.saveLocked()
}

func (s *Store) SavePrefs(prefs UIPrefs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Prefs = prefs
	return s.saveLocked()
}
