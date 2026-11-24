package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const maxHistoryPerTopic = 50

// HistoryPoint represents one timestamped message payload for a topic.
type HistoryPoint struct {
	TimestampMs int64       `json:"ts"`
	Payload     interface{} `json:"payload"`
	Raw         string      `json:"raw"`
}

// TopicEntry holds the latest message, diff baseline, and history of a topic.
type TopicEntry struct {
	Topic       string         `json:"topic"`
	Retained    bool           `json:"retained"`
	Payload     interface{}    `json:"payload"`
	Raw         string         `json:"raw"`
	PrevPayload interface{}    `json:"prevPayload"`
	PrevRaw     string         `json:"prevRaw"`
	NumericKey  string         `json:"numericKey"`
	Count       int            `json:"count"`
	UpdatedAtMs int64          `json:"updatedAt"`
	History     []HistoryPoint `json:"history"`
}

// ConnectionStatus reports the live MQTT connection state to the UI.
type ConnectionStatus struct {
	State      string `json:"state"` // disconnected | connecting | connected | error
	BrokerID   string `json:"brokerId"`
	BrokerName string `json:"brokerName"`
	Message    string `json:"message"`
	Paused     bool   `json:"paused"`
}

// TestConnectionResult reports the diagnostic outcome of testing a broker profile.
type TestConnectionResult struct {
	OK        bool   `json:"ok"`
	LatencyMs int64  `json:"latencyMs"`
	Message   string `json:"message"`
}

// AppSnapshot is pushed to or fetched by the WebView UI.
type AppSnapshot struct {
	Status    ConnectionStatus      `json:"status"`
	Topics    map[string]TopicEntry `json:"topics"`
	Persisted PersistedState        `json:"persisted"`
	Flashed   []string              `json:"flashed"`
}

// MqttManager coordinates the live Paho MQTT client and topic state.
type MqttManager struct {
	mu         sync.RWMutex
	store      *Store
	client     mqtt.Client
	status     ConnectionStatus
	topics     map[string]*TopicEntry
	flashed    map[string]bool
	dirty      bool
	onNotify   func()
	stopTicker chan struct{}
}

func NewMqttManager(store *Store, onNotify func()) *MqttManager {
	m := &MqttManager{
		store:      store,
		topics:     map[string]*TopicEntry{},
		flashed:    map[string]bool{},
		onNotify:   onNotify,
		stopTicker: make(chan struct{}),
		status: ConnectionStatus{
			State:   "disconnected",
			Message: "Prêt à se connecter",
		},
	}
	go m.batchNotifier()
	return m
}

func (m *MqttManager) batchNotifier() {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopTicker:
			return
		case <-ticker.C:
			m.mu.Lock()
			shouldNotify := m.dirty
			m.dirty = false
			m.mu.Unlock()
			if shouldNotify && m.onNotify != nil {
				m.onNotify()
			}
		}
	}
}

func (m *MqttManager) Close() {
	close(m.stopTicker)
	m.Disconnect()
}

func buildBrokerURL(p BrokerProfile) (string, error) {
	host := strings.TrimSpace(p.Host)
	if host == "" {
		return "", errors.New("Veuillez saisir une adresse de serveur valide.")
	}
	if p.Port < 1 || p.Port > 65535 {
		return "", errors.New("Le port doit être compris entre 1 et 65535.")
	}
	switch strings.ToLower(p.Proto) {
	case "mqtt", "":
		return fmt.Sprintf("tcp://%s:%d", host, p.Port), nil
	case "mqtts":
		return fmt.Sprintf("ssl://%s:%d", host, p.Port), nil
	case "ws":
		return fmt.Sprintf("ws://%s:%d/mqtt", host, p.Port), nil
	case "wss":
		return fmt.Sprintf("wss://%s:%d/mqtt", host, p.Port), nil
	default:
		return "", fmt.Errorf("Protocole non supporté : %s", p.Proto)
	}
}

func translateMqttError(err error, p BrokerProfile) string {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "not authorized"), strings.Contains(msg, "bad user name or password"):
		return "Identifiant ou mot de passe refusé par le serveur MQTT."
	case strings.Contains(msg, "connection refused"):
		return fmt.Sprintf("Connexion refusée sur %s:%d. Vérifiez que le broker Docker ou local est démarré.", p.Host, p.Port)
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "lookup"):
		return fmt.Sprintf("Adresse introuvable (%s). Vérifiez l'orthographe ou votre connexion réseau.", p.Host)
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "i/o timeout"):
		return fmt.Sprintf("Délai d'attente dépassé vers %s:%d. Vérifiez le port ou le pare-feu.", p.Host, p.Port)
	case strings.Contains(msg, "tls"), strings.Contains(msg, "certificate"), strings.Contains(msg, "x509"):
		return fmt.Sprintf("Échec TLS (%s). Vérifiez le certificat CA, la paire certificat/clé client ou l'option auto-signée.", err.Error())
	default:
		return fmt.Sprintf("Impossible de se connecter : %s", err.Error())
	}
}

func buildTLSConfig(p BrokerProfile) (*tls.Config, error) {
	caPath := strings.TrimSpace(p.CACertPath)
	certPath := strings.TrimSpace(p.ClientCertPath)
	keyPath := strings.TrimSpace(p.ClientKeyPath)

	if (certPath != "" && keyPath == "") || (certPath == "" && keyPath != "") {
		return nil, errors.New("Pour l'authentification mTLS, renseignez à la fois le certificat client et la clé privée.")
	}

	cfg := &tls.Config{
		InsecureSkipVerify: p.InsecureSkipVerify,
	}

	if caPath != "" {
		caPEM, err := os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("Impossible de lire le certificat CA (%s) : %w", caPath, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("Le certificat CA (%s) n'est pas au format PEM valide.", caPath)
		}
		cfg.RootCAs = pool
	}

	if certPath != "" && keyPath != "" {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("Impossible de charger le certificat client ou sa clé privée : %w", err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}

	return cfg, nil
}

func isTimestampField(k string) bool {
	lower := strings.ToLower(k)
	return strings.HasSuffix(lower, "atms") || lower == "ts" || lower == "timestamp" || lower == "timestampms"
}

var preferredMetricOrder = []string{
	"avgQualityScore", "qualityScore", "canonicalValue", "pipelineLatencyMs",
	"avgPipelineLatencyMs", "numericValue", "latencyMs", "ingestLatencyMs",
	"processedCount", "heapUsedMb", "amount", "percent", "value",
}

func parsePayloadValue(raw string) (interface{}, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		switch v := parsed.(type) {
		case float64:
			return v, "__scalar__"
		case map[string]interface{}:
			for _, pref := range preferredMetricOrder {
				if val, exists := v[pref]; exists {
					if _, ok := val.(float64); ok {
						return v, pref
					}
				}
			}
			keys := make([]string, 0, len(v))
			for k, val := range v {
				if _, ok := val.(float64); ok && !isTimestampField(k) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			if len(keys) > 0 {
				return v, keys[0]
			}
			return v, ""
		default:
			return v, ""
		}
	}
	return raw, ""
}

func (m *MqttManager) ingestMessage(topic string, raw string, retained bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.Paused {
		return
	}

	if raw == "" && retained {
		delete(m.topics, topic)
		m.dirty = true
		return
	}

	nowMs := time.Now().UnixMilli()
	parsed, numKey := parsePayloadValue(raw)
	existing, ok := m.topics[topic]
	if ok {
		existing.PrevPayload = existing.Payload
		existing.PrevRaw = existing.Raw
		existing.Payload = parsed
		existing.Raw = raw
		existing.Retained = retained || existing.Retained
		if numKey != "" {
			existing.NumericKey = numKey
		}
		existing.Count++
		existing.UpdatedAtMs = nowMs
		existing.History = append(existing.History, HistoryPoint{
			TimestampMs: nowMs,
			Payload:     parsed,
			Raw:         raw,
		})
		if len(existing.History) > maxHistoryPerTopic {
			existing.History = existing.History[len(existing.History)-maxHistoryPerTopic:]
		}
	} else {
		m.topics[topic] = &TopicEntry{
			Topic:       topic,
			Retained:    retained,
			Payload:     parsed,
			Raw:         raw,
			NumericKey:  numKey,
			Count:       1,
			UpdatedAtMs: nowMs,
			History: []HistoryPoint{
				{
					TimestampMs: nowMs,
					Payload:     parsed,
					Raw:         raw,
				},
			},
		}
	}
	m.flashed[topic] = true
	m.dirty = true
}

func (m *MqttManager) Disconnect() {
	m.mu.Lock()
	client := m.client
	m.client = nil
	m.status.State = "disconnected"
	m.status.Message = "Déconnecté"
	m.dirty = true
	m.mu.Unlock()

	if client != nil && client.IsConnected() {
		client.Disconnect(250)
	}
}

func (m *MqttManager) Connect(p BrokerProfile) error {
	m.Disconnect()

	brokerURL, err := buildBrokerURL(p)
	if err != nil {
		m.mu.Lock()
		m.status = ConnectionStatus{
			State:      "error",
			BrokerID:   p.ID,
			BrokerName: p.Name,
			Message:    err.Error(),
		}
		m.dirty = true
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	m.topics = map[string]*TopicEntry{}
	m.flashed = map[string]bool{}
	m.status = ConnectionStatus{
		State:      "connecting",
		BrokerID:   p.ID,
		BrokerName: p.Name,
		Message:    fmt.Sprintf("Connexion à %s…", brokerURL),
	}
	m.dirty = true
	m.mu.Unlock()

	subFilter := strings.TrimSpace(p.Subscription)
	if subFilter == "" {
		subFilter = "#"
	}

	opts, optsErr := m.buildClientOptions(p, brokerURL, true, subFilter)
	if optsErr != nil {
		m.mu.Lock()
		m.status = ConnectionStatus{State: "error", BrokerID: p.ID, BrokerName: p.Name, Message: optsErr.Error()}
		m.dirty = true
		m.mu.Unlock()
		return optsErr
	}
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(8 * time.Second) {
		errMsg := fmt.Sprintf("Délai d'attente dépassé vers %s:%d.", p.Host, p.Port)
		m.mu.Lock()
		m.status = ConnectionStatus{State: "error", BrokerID: p.ID, BrokerName: p.Name, Message: errMsg}
		m.dirty = true
		m.mu.Unlock()
		return errors.New(errMsg)
	}
	if token.Error() != nil {
		errMsg := translateMqttError(token.Error(), p)
		m.mu.Lock()
		m.status = ConnectionStatus{State: "error", BrokerID: p.ID, BrokerName: p.Name, Message: errMsg}
		m.dirty = true
		m.mu.Unlock()
		return errors.New(errMsg)
	}

	m.mu.Lock()
	m.client = client
	m.status = ConnectionStatus{
		State:      "connected",
		BrokerID:   p.ID,
		BrokerName: p.Name,
		Message:    fmt.Sprintf("Connecté à %s", p.Name),
	}
	m.dirty = true
	m.mu.Unlock()
	return nil
}

func (m *MqttManager) buildClientOptions(p BrokerProfile, brokerURL string, subscribe bool, subFilter string) (*mqtt.ClientOptions, error) {
	opts := mqtt.NewClientOptions().
		AddBroker(brokerURL).
		SetConnectTimeout(5 * time.Second).
		SetAutoReconnect(subscribe).
		SetCleanSession(true)

	clientID := strings.TrimSpace(p.ClientID)
	if clientID == "" {
		clientID = fmt.Sprintf("topiqtt-%d", time.Now().UnixNano()%1000000)
	}
	opts.SetClientID(clientID)

	if p.Username != "" {
		opts.SetUsername(p.Username)
		opts.SetPassword(p.Password)
	}
	if strings.HasPrefix(brokerURL, "ssl://") || strings.HasPrefix(brokerURL, "wss://") {
		tlsCfg, err := buildTLSConfig(p)
		if err != nil {
			return nil, err
		}
		opts.SetTLSConfig(tlsCfg)
	}

	if subscribe {
		opts.SetOnConnectHandler(func(c mqtt.Client) {
			c.Subscribe(subFilter, 0, func(_ mqtt.Client, msg mqtt.Message) {
				m.ingestMessage(msg.Topic(), string(msg.Payload()), msg.Retained())
			})
			// Also subscribe to $SYS broker telemetry when listening to #
			if subFilter == "#" {
				c.Subscribe("$SYS/#", 0, func(_ mqtt.Client, msg mqtt.Message) {
					m.ingestMessage(msg.Topic(), string(msg.Payload()), msg.Retained())
				})
			}
			m.mu.Lock()
			m.status.State = "connected"
			m.status.Message = fmt.Sprintf("Connecté à %s", p.Name)
			m.dirty = true
			m.mu.Unlock()
		})
		opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			m.mu.Lock()
			m.status.State = "error"
			m.status.Message = translateMqttError(err, p)
			m.dirty = true
			m.mu.Unlock()
		})
	}
	return opts, nil
}

func (m *MqttManager) TestConnection(p BrokerProfile) TestConnectionResult {
	brokerURL, err := buildBrokerURL(p)
	if err != nil {
		return TestConnectionResult{OK: false, Message: err.Error()}
	}

	start := time.Now()
	if p.Proto == "mqtt" || p.Proto == "" {
		conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", p.Host, p.Port), 3*time.Second)
		if dialErr != nil {
			return TestConnectionResult{OK: false, Message: translateMqttError(dialErr, p)}
		}
		_ = conn.Close()
	}

	opts, optsErr := m.buildClientOptions(p, brokerURL, false, "")
	if optsErr != nil {
		return TestConnectionResult{OK: false, Message: optsErr.Error()}
	}
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(5 * time.Second) {
		return TestConnectionResult{
			OK:      false,
			Message: fmt.Sprintf("Délai d'attente dépassé vers %s:%d.", p.Host, p.Port),
		}
	}
	if token.Error() != nil {
		return TestConnectionResult{
			OK:      false,
			Message: translateMqttError(token.Error(), p),
		}
	}
	latency := time.Since(start).Milliseconds()
	client.Disconnect(100)

	return TestConnectionResult{
		OK:        true,
		LatencyMs: latency,
		Message:   fmt.Sprintf("Connexion réussie (%d ms). Le serveur MQTT répond correctement.", latency),
	}
}

func (m *MqttManager) Publish(topic string, payload string, qos byte, retain bool) error {
	clean := strings.Trim(strings.TrimSpace(topic), "/")
	if clean == "" {
		return errors.New("Le chemin du topic ne peut pas être vide.")
	}

	m.mu.RLock()
	client := m.client
	m.mu.RUnlock()

	if client == nil || !client.IsConnected() {
		return errors.New("Non connecté à un serveur MQTT.")
	}
	token := client.Publish(clean, qos, retain, payload)
	if !token.WaitTimeout(4 * time.Second) {
		return errors.New("Délai dépassé lors de la publication du message.")
	}
	return token.Error()
}

func (m *MqttManager) ClearTopics(topics []string) error {
	m.mu.RLock()
	client := m.client
	m.mu.RUnlock()

	if client == nil || !client.IsConnected() {
		return errors.New("Non connecté à un serveur MQTT.")
	}
	for _, t := range topics {
		tok := client.Publish(t, 1, true, "")
		tok.WaitTimeout(2 * time.Second)
	}

	m.mu.Lock()
	for _, t := range topics {
		delete(m.topics, t)
	}
	m.dirty = true
	m.mu.Unlock()
	return nil
}

func (m *MqttManager) SetPaused(paused bool) {
	m.mu.Lock()
	m.status.Paused = paused
	m.dirty = true
	m.mu.Unlock()
}

func (m *MqttManager) Snapshot() AppSnapshot {
	m.mu.Lock()
	topicsCopy := make(map[string]TopicEntry, len(m.topics))
	for k, v := range m.topics {
		cp := *v
		cp.History = append([]HistoryPoint(nil), v.History...)
		topicsCopy[k] = cp
	}
	flashedList := make([]string, 0, len(m.flashed))
	for k := range m.flashed {
		flashedList = append(flashedList, k)
	}
	m.flashed = map[string]bool{}
	status := m.status
	m.mu.Unlock()

	return AppSnapshot{
		Status:    status,
		Topics:    topicsCopy,
		Persisted: m.store.Snapshot(),
		Flashed:   flashedList,
	}
}
