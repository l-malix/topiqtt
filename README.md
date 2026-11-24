# TopiQTT

Explorateur MQTT léger et créateur de dashboards multi-courbes pour Windows (WebView2 natif, binaire portable autonome sans installateur).

## Fonctionnalités

- **Connexion multi-protocoles et TLS/mTLS** : `mqtt://`, `mqtts://`, `ws://`, `wss://`, certificats CA et paire client/clé mTLS optionnels, test de latence avant connexion et messages de diagnostic en français. Démarre vierge (aucun profil préconfiguré).
- **Arborescence hiérarchique (`/`)** : navigation par branches et feuilles, aperçus en direct, indicateur `Retain`, épinglage de favoris et filtre instantané (`Ctrl+K`).
- **Inspecteur multi-vues** : Vue lisible clé/valeur, JSON / Brut, Comparaison (`Diff` avec le message précédent), Graphique temps réel & Historique.
- **Publication assistée** : panneau ajustable en hauteur, formats JSON / Texte brut, QoS `0/1/2` et `Retain`.
- **Dashboards multi-courbes** : superposition de plusieurs topics/champs numériques sur un même graphique (échelle réelle ou normalisée `0–100 %`, survol interactif, légende cliquable), persistés localement.
- **Thèmes Auto / Clair / Sombre** : suit automatiquement le thème Windows ou bascule manuellement.

## Confidentialité

Ce programme ne transmet aucune information vers des systèmes réseau sans action explicite de l'utilisateur (connexion, souscription ou publication vers un broker MQTT configuré par l'utilisateur). Aucune télémétrie ni vérification automatique de mise à jour n'est effectuée. Voir [PRIVACY.md](PRIVACY.md).

## Politique de signature de code (Code Signing Policy)

Free code signing provided by [SignPath.io](https://signpath.io/), using a certificate by [SignPath Foundation](https://signpath.org/).

- Les binaires Windows officiels sont compilés exclusivement depuis le code source public via GitHub Actions (`.github/workflows/release.yml`).
- Les clés de signature sont hébergées sur le HSM de SignPath Foundation et ne sont jamais exposées dans le dépôt.
- Les personnes habilitées à valider une release signée sont les mainteneurs du dépôt (`l-malix`).

## Développement et compilation locale (Windows)

Prérequis : **Go 1.25+** (aucun compilateur C/C++ requis grâce à `CGO_ENABLED=0` et `go-webview2`) et **Microsoft Edge WebView2 Runtime** (inclus sur Windows 10/11 récents).

```powershell
# Lancer les tests unitaires
go test -v ./...

# Générer les ressources Windows (icône + manifeste DPI + VersionInfo)
go run github.com/tc-hib/go-winres@v0.3.3 make --arch amd64

# Compiler l'exécutable portable
go build -ldflags="-H windowsgui -s -w" -o TopiQTT.exe .
```

## Licence

Distribué sous licence [MIT](LICENSE).
