# 🎧 Help Desk Console — Task, SLA & Timesheet Giornaliero

Applicazione web full-stack leggera (Python + SQLite + Vanilla JS) progettata per gli operatori **Help Desk / Service Desk** per monitorare i ticket della giornata lavorativa, tenere traccia delle scadenze **SLA**, cronometrare il tempo speso su ogni richiesta e generare il **Report di Fine Turno** (passaggio consegne).

## ✨ Funzionalità Principali

- 🔐 **Autenticazione Operatore su Database**: Registrazione e Login via Email e Password (cifrate con `PBKDF2-HMAC-SHA256` + salt) e gestione sessioni su SQLite.
- 🌗 **Dark Mode & Light Mode**: Tema scuro e tema chiaro con salvataggio automatico della preferenza nel profilo utente sul database.
- 📋 **Vista Kanban (Drag & Drop) & Vista Tabella**: Colonne dedicate agli stati Help Desk (*Da Fare*, *In Lavorazione*, *In Attesa Utente/Fornitore*, *Risolti*).
- ⏳ **Monitoraggio SLA in Tempo Reale**: Priorità **P1 (1h)**, **P2 (4h)**, **P3 (8h)**, **P4 (24h)** o personalizzate, con avvisi visivi quando il ticket è in scadenza (`< 30 min`) o fuori SLA.
- ⏱️ **Cronometro Ticket & Timesheet**: Timer singolo attivo con pausa automatica sugli altri ticket, pulsanti rapidi `+15m` / `+30m` e calcolo del totale lavorato nella giornata.
- ⚡ **Risposte Standard (Template) & Diario Attività**: Template rapidi con variabili dinamiche (`{utente}`, `{ticket}`, `{titolo}`, `{priorita}`) e log cronologico per ogni ticket.
- 📊 **Report Fine Giornata & Export CSV**: Generatore automatico di report testuale per passaggio consegne + esportazione in CSV per Excel.

## 🚀 Avvio Rapido

Non richiede librerie esterne (usa esclusivamente la libreria standard di **Python 3**).

```bash
python3 server.py
```

Poi apri il browser su: **[http://127.0.0.1:8765](http://127.0.0.1:8765)**

Su macOS puoi anche fare doppio clic su `start.command`.
