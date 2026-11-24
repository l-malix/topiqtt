package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func TestStoreSaveAndReloadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s1, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	profile := BrokerProfile{
		ID:           "custom-1",
		Name:         "Cluster Staging",
		Proto:        "mqtt",
		Host:         "localhost",
		Port:         1883,
		Subscription: "enterprise/#",
	}
	if err := s1.UpsertProfile(profile); err != nil {
		t.Fatalf("UpsertProfile failed: %v", err)
	}
	if err := s1.SaveDashboards("custom-1", []DashboardConfig{
		{
			ID:   "d1",
			Name: "Latence Multi-Courbes",
			Charts: []ChartConfig{
				{
					ID:     "c1",
					Title:  "API vs Worker",
					Span:   2,
					Height: 240,
					Scale:  "normalized",
					Series: []SeriesConfig{
						{Topic: "enterprise/eu/latency", Field: "__scalar__", Label: "API", Color: "#2563EB"},
						{Topic: "enterprise/eu/queue", Field: "depth", Label: "Queue", Color: "#16A34A"},
					},
				},
			},
		},
	}, "d1"); err != nil {
		t.Fatalf("SaveDashboards failed: %v", err)
	}

	s2, err := NewStore(path)
	if err != nil {
		t.Fatalf("reload NewStore failed: %v", err)
	}
	snap := s2.Snapshot()
	if snap.ActiveBrokerID != "custom-1" {
		t.Fatalf("expected ActiveBrokerID=custom-1, got %q", snap.ActiveBrokerID)
	}
	dashes := snap.Dashboards["custom-1"]
	if len(dashes) != 1 || len(dashes[0].Charts) != 1 || len(dashes[0].Charts[0].Series) != 2 {
		t.Fatalf("unexpected reloaded dashboards: %+v", dashes)
	}
}

func TestIngestDeepPipelineMessageAndNumericDetection(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	mgr := NewMqttManager(store, nil)
	defer mgr.Close()

	deepTopic := "enterprise/emea/france/paris-dc1/cluster-prod-01/pipelines/data-reliability/v2/tenant-acme-logistics/cold-chain-freight/stage-04-quality-validator/scored-records/shard-01/outbound-events"
	mgr.ingestMessage(deepTopic, `{"ingestedAtMs": 1795531400000, "qualityScore": 98.5, "canonicalValue": 4.2}`, false)
	mgr.ingestMessage(deepTopic, `{"ingestedAtMs": 1795531402000, "qualityScore": 99.1, "canonicalValue": 4.4}`, true)

	snap := mgr.Snapshot()
	entry, ok := snap.Topics[deepTopic]
	if !ok {
		t.Fatalf("expected deep topic in snapshot")
	}
	if entry.NumericKey != "qualityScore" {
		t.Fatalf("expected qualityScore numeric key (ignoring ingestedAtMs), got %q", entry.NumericKey)
	}
	if entry.Count != 2 || len(entry.History) != 2 || !entry.Retained || entry.PrevPayload == nil {
		t.Fatalf("unexpected entry state: %+v", entry)
	}
}

func TestTranslateMqttErrorMessages(t *testing.T) {
	p := BrokerProfile{Host: "10.0.0.5", Port: 1883}
	if msg := translateMqttError(errors.New("dial tcp 10.0.0.5:1883: connectex: connection refused"), p); msg == "" {
		t.Fatalf("expected friendly French message for connection refused")
	}
	if msg := translateMqttError(errors.New("Not Authorized"), p); msg != "Identifiant ou mot de passe refusé par le serveur MQTT." {
		t.Fatalf("unexpected auth error message: %q", msg)
	}
}

func TestBuildDesktopHTML(t *testing.T) {
	html, err := buildDesktopHTML()
	if err != nil {
		t.Fatalf("buildDesktopHTML failed: %v", err)
	}
	if len(html) == 0 || len(html) > 1_500_000 {
		t.Fatalf("unexpected html byte size: %d", len(html))
	}
	if !strings.Contains(html, "renderObjectKeyValueTable") {
		t.Fatalf("expected updated readable view renderer in embedded HTML")
	}
}

func TestIngestJSONObjectListPayload(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	mgr := NewMqttManager(store, nil)
	defer mgr.Close()

	mgr.ingestMessage("sensors/batch", `[{"id":"s1","temp":21.5},{"id":"s2","temp":23.0}]`, false)
	snap := mgr.Snapshot()
	raw, err := json.Marshal(snap.Topics["sensors/batch"].Payload)
	if err != nil {
		t.Fatalf("marshal payload failed: %v", err)
	}
	if !strings.HasPrefix(string(raw), `[{"id":"s1"`) {
		t.Fatalf("expected JSON array of objects, got %s", string(raw))
	}
}

func TestStoreStartsWithZeroProfilesAndDeletesToZero(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Profiles) != 0 || snap.ActiveBrokerID != "" {
		t.Fatalf("expected 0 default profiles and empty ActiveBrokerID, got %d profiles, active=%q", len(snap.Profiles), snap.ActiveBrokerID)
	}

	prof := BrokerProfile{
		ID:             "tls-1",
		Name:           "Prod TLS",
		Proto:          "mqtts",
		Host:           "mqtt.example.com",
		Port:           8883,
		CACertPath:     `C:\certs\ca.crt`,
		ClientCertPath: `C:\certs\client.crt`,
		ClientKeyPath:  `C:\certs\client.key`,
	}
	if err := s.UpsertProfile(prof); err != nil {
		t.Fatalf("UpsertProfile failed: %v", err)
	}

	sReload, err := NewStore(path)
	if err != nil {
		t.Fatalf("reload failed: %v", err)
	}
	reloaded := sReload.Snapshot()
	if len(reloaded.Profiles) != 1 || reloaded.Profiles[0].CACertPath != prof.CACertPath || reloaded.Profiles[0].ClientKeyPath != prof.ClientKeyPath {
		t.Fatalf("unexpected reloaded cert fields: %+v", reloaded.Profiles)
	}

	if err := sReload.DeleteProfile("tls-1"); err != nil {
		t.Fatalf("DeleteProfile last profile failed: %v", err)
	}
	sEmpty, err := NewStore(path)
	if err != nil {
		t.Fatalf("reload after delete failed: %v", err)
	}
	afterDelete := sEmpty.Snapshot()
	if len(afterDelete.Profiles) != 0 || afterDelete.ActiveBrokerID != "" {
		t.Fatalf("expected 0 profiles after deleting last profile, got %+v", afterDelete)
	}
}

func TestBuildTLSConfigAndWin32Struct(t *testing.T) {
	if unsafe.Sizeof(openFileNameW{}) != 152 {
		t.Fatalf("unexpected openFileNameW size: %d", unsafe.Sizeof(openFileNameW{}))
	}

	if _, err := buildTLSConfig(BrokerProfile{ClientCertPath: "only-cert.pem"}); err == nil {
		t.Fatalf("expected error when client key is missing")
	}
	if _, err := buildTLSConfig(BrokerProfile{CACertPath: filepath.Join(t.TempDir(), "missing.pem")}); err == nil {
		t.Fatalf("expected error when CA cert file does not exist")
	}

	dir := t.TempDir()
	badCA := filepath.Join(dir, "bad-ca.pem")
	if err := os.WriteFile(badCA, []byte("not a pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := buildTLSConfig(BrokerProfile{CACertPath: badCA}); err == nil {
		t.Fatalf("expected error for invalid PEM CA")
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "TopiQTT Test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		IsCA:         true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}

	certPath := filepath.Join(dir, "test.crt")
	keyPath := filepath.Join(dir, "test.key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)}), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := buildTLSConfig(BrokerProfile{
		CACertPath:         certPath,
		ClientCertPath:     certPath,
		ClientKeyPath:      keyPath,
		InsecureSkipVerify: true,
	})
	if err != nil {
		t.Fatalf("buildTLSConfig valid mTLS failed: %v", err)
	}
	if cfg.RootCAs == nil || len(cfg.Certificates) != 1 || !cfg.InsecureSkipVerify {
		t.Fatalf("unexpected TLS config: %+v", cfg)
	}
}
