#!/usr/bin/env python3
"""
Help Desk Task & SLA Tracker - Backend Python + SQLite
Include Autenticazione (Email + Password con PBKDF2-HMAC-SHA256), Sessioni su DB e Preferenze Tema (Dark/Light).
Zero dipendenze esterne (usa la libreria standard Python: http.server + sqlite3 + hashlib + secrets + json).
"""

import sqlite3
import json
import os
import sys
import datetime
import hashlib
import secrets
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "helpdesk.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

SLA_DEFAULT_MINUTES = {
    "P1": 60,     # 1 ora (Critico)
    "P2": 240,    # 4 ore (Alto)
    "P3": 480,    # 8 ore (Normale)
    "P4": 1440    # 24 ore (Basso)
}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        100_000
    ).hex()
    return pwd_hash, salt


def verify_password(password: str, stored_hash: str, salt: str) -> bool:
    computed_hash, _ = hash_password(password, salt)
    return secrets.compare_digest(computed_hash, stored_hash)


def ensure_column(cur, table_name, col_name, col_def):
    cur.execute(f"PRAGMA table_info({table_name})")
    existing = [r["name"] for r in cur.fetchall()]
    if col_name not in existing:
        cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_def}")


def init_db():
    conn = get_db()
    cur = conn.cursor()

    # Users table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            role TEXT DEFAULT 'Operatore Help Desk',
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            theme_preference TEXT DEFAULT 'dark',
            created_at TEXT NOT NULL
        )
    """)

    # Sessions table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)

    # Tasks table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT NULL,
            ticket_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            requester_name TEXT DEFAULT '',
            requester_dept TEXT DEFAULT '',
            category TEXT DEFAULT 'Software',
            priority TEXT DEFAULT 'P3',
            status TEXT DEFAULT 'todo',
            created_at TEXT NOT NULL,
            sla_deadline TEXT NOT NULL,
            resolved_at TEXT DEFAULT NULL,
            time_spent_seconds INTEGER DEFAULT 0,
            timer_started_at TEXT DEFAULT NULL,
            work_date TEXT NOT NULL
        )
    """)
    ensure_column(cur, "tasks", "user_id", "INTEGER DEFAULT NULL")

    # Activity logs table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            log_type TEXT DEFAULT 'note',
            created_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
    """)

    # Templates table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT NULL,
            title TEXT NOT NULL,
            category TEXT DEFAULT 'Generale',
            content TEXT NOT NULL
        )
    """)
    ensure_column(cur, "templates", "user_id", "INTEGER DEFAULT NULL")

    # Seed default templates if none exist
    cur.execute("SELECT COUNT(*) as cnt FROM templates")
    if cur.fetchone()["cnt"] == 0:
        default_templates = [
            (
                "Reset Password / Sblocco Account AD",
                "Account",
                "Ciao {utente},\nla tua password di dominio è stata resettata come richiesto per il ticket #{ticket}.\nPassword temporanea: TempPass2026!\nAl primo accesso ti verrà chiesto di modificarla.\nRestiamo a disposizione,\nSupporto Help Desk"
            ),
            (
                "Richiesta Maggiori Informazioni / Screenshot",
                "Generale",
                "Ciao {utente},\nin merito alla segnalazione #{ticket} ({titolo}), potresti inviarci uno screenshot dell'errore e indicarci l'orario approssimativo in cui si è verificato?\nNel frattempo il ticket resta in stato 'In attesa utente'.\nGrazie,\nSupporto Help Desk"
            ),
            (
                "Sollecito Fornitore Esterno / Escalation",
                "Rete",
                "Gentile Fornitore,\nsollecitiamo un aggiornamento urgente per il ticket interno #{ticket} relativo a: {titolo}.\nPriorità attuale: {priorita}.\nGrazie per il riscontro."
            ),
            (
                "Risoluzione e Chiusura Ticket",
                "Generale",
                "Ciao {utente},\nti confermiamo che l'anomalia segnalata nel ticket #{ticket} ({titolo}) è stata risolta.\nProcediamo alla chiusura della richiesta; se il problema dovesse ripresentarsi non esitare a ricontattarci.\nBuon lavoro,\nSupporto Help Desk"
            ),
            (
                "Verifica Riavvio / Pulizia Cache VPN",
                "Rete",
                "Ciao {utente},\nper risolvere il problema di connessione VPN (#{ticket}), ti chiediamo di:\n1. Disconnettere il client VPN e chiuderlo completamente dalla barra di stato.\n2. Riavviare il PC.\n3. Riprovare l'accesso con il token MFA.\nFacci sapere se l'accesso va a buon fine."
            )
        ]
        cur.executemany(
            "INSERT INTO templates (title, category, content) VALUES (?, ?, ?)",
            default_templates
        )

    # Seed sample tasks if database has no tasks at all
    cur.execute("SELECT COUNT(*) as cnt FROM tasks")
    if cur.fetchone()["cnt"] == 0:
        now = datetime.datetime.now()
        today_str = now.strftime("%Y-%m-%d")

        t1_created = (now - datetime.timedelta(minutes=38)).isoformat(timespec='seconds')
        t1_sla = (now + datetime.timedelta(minutes=22)).isoformat(timespec='seconds')

        t2_created = (now - datetime.timedelta(hours=2)).isoformat(timespec='seconds')
        t2_sla = (now + datetime.timedelta(hours=2)).isoformat(timespec='seconds')

        t3_created = (now - datetime.timedelta(hours=3)).isoformat(timespec='seconds')
        t3_sla = (now + datetime.timedelta(hours=5)).isoformat(timespec='seconds')

        t4_created = (now - datetime.timedelta(hours=4)).isoformat(timespec='seconds')
        t4_sla = (now + datetime.timedelta(hours=4)).isoformat(timespec='seconds')
        t4_resolved = (now - datetime.timedelta(hours=1)).isoformat(timespec='seconds')

        sample_tasks = [
            (
                "INC-4091",
                "Blocco totale gestionale ERP reparto Contabilità",
                "Gli utenti del piano 2 ricevono errore 'Timeout DB Connection 504' all'apertura delle fatture.",
                "Marco Rossi",
                "Amministrazione",
                "Software",
                "P1",
                "in_progress",
                t1_created,
                t1_sla,
                None,
                1420,
                None,
                today_str
            ),
            (
                "INC-4092",
                "Configurazione VPN e Token MFA su nuovo laptop aziendale",
                "Utente in smart working non riesce ad autenticare FortiClient VPN dopo cambio smartphone.",
                "Laura Bianchi",
                "Commerciale",
                "Rete",
                "P2",
                "waiting",
                t2_created,
                t2_sla,
                None,
                840,
                None,
                today_str
            ),
            (
                "SRQ-1184",
                "Sostituzione dock station USB-C e doppio monitor sfarfallante",
                "Il secondo monitor esterno perde il segnale HDMI ogni 10 minuti. Testare nuovo cavo o dock.",
                "Giuseppe Verdi",
                "Ufficio Tecnico",
                "Hardware",
                "P3",
                "todo",
                t3_created,
                t3_sla,
                None,
                0,
                None,
                today_str
            ),
            (
                "SRQ-1180",
                "Sblocco utenza Active Directory e reset password posta",
                "Account bloccato dopo 5 tentativi errati post cambio password trimestrale.",
                "Elena Neri",
                "Risorse Umane",
                "Account",
                "P3",
                "resolved",
                t4_created,
                t4_sla,
                t4_resolved,
                630,
                None,
                today_str
            )
        ]

        for st in sample_tasks:
            cur.execute("""
                INSERT INTO tasks (
                    ticket_id, title, description, requester_name, requester_dept,
                    category, priority, status, created_at, sla_deadline,
                    resolved_at, time_spent_seconds, timer_started_at, work_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, st)
            tid = cur.lastrowid
            cur.execute("""
                INSERT INTO activity_logs (task_id, note, log_type, created_at)
                VALUES (?, ?, 'system', ?)
            """, (tid, f"Ticket {st[0]} aperto con priorità {st[6]}", st[8]))

            if st[0] == "INC-4091":
                cur.execute("""
                    INSERT INTO activity_logs (task_id, note, log_type, created_at)
                    VALUES (?, ?, 'note', ?)
                """, (tid, "Verificato stato servizio SQL: pool di connessioni saturo. Riavvio servizio applicativo in corso.", now.isoformat(timespec='seconds')))
            elif st[0] == "INC-4092":
                cur.execute("""
                    INSERT INTO activity_logs (task_id, note, log_type, created_at)
                    VALUES (?, ?, 'note', ?)
                """, (tid, "Inviato nuovo QR code MFA via mail secondaria; in attesa che l'utente confermi l'accesso.", now.isoformat(timespec='seconds')))

    conn.commit()
    conn.close()


def serialize_task(row, logs=None):
    d = dict(row)
    extra_seconds = 0
    if d.get("timer_started_at"):
        try:
            started = datetime.datetime.fromisoformat(d["timer_started_at"])
            now = datetime.datetime.now()
            extra_seconds = max(0, int((now - started).total_seconds()))
        except ValueError:
            extra_seconds = 0
    d["live_time_spent_seconds"] = (d.get("time_spent_seconds") or 0) + extra_seconds
    if logs is not None:
        d["logs"] = logs
    return d


def serialize_user(row):
    return {
        "id": row["id"],
        "email": row["email"],
        "full_name": row["full_name"],
        "role": row["role"],
        "theme_preference": row["theme_preference"] or "dark",
        "created_at": row["created_at"]
    }


class HelpDeskHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def _get_current_user(self):
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return None
        token = auth_header[7:].strip()
        if not token:
            return None

        conn = get_db()
        cur = conn.cursor()
        now_iso = datetime.datetime.now().isoformat(timespec="seconds")
        cur.execute("""
            SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
        """, (token, now_iso))
        user_row = cur.fetchone()
        conn.close()
        return user_row

    def _create_session(self, conn, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = datetime.datetime.now()
        expires = now + datetime.timedelta(days=30)
        conn.execute("""
            INSERT INTO sessions (token, user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
        """, (token, user_id, now.isoformat(timespec="seconds"), expires.isoformat(timespec="seconds")))
        # Assign any orphan seeded tasks (where user_id IS NULL) to the first user who logs in / registers
        conn.execute("UPDATE tasks SET user_id = ? WHERE user_id IS NULL", (user_id,))
        conn.commit()
        return token

    def _serve_static(self, rel_path):
        if rel_path == "" or rel_path == "/":
            rel_path = "index.html"
        safe_path = os.path.normpath(os.path.join(STATIC_DIR, rel_path.lstrip("/")))
        if not safe_path.startswith(STATIC_DIR) or not os.path.isfile(safe_path):
            self.send_error(404, "File non trovato")
            return

        ext = os.path.splitext(safe_path)[1].lower()
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon"
        }
        ctype = content_types.get(ext, "application/octet-stream")
        with open(safe_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # Auth status check
        if path == "/api/auth/me":
            user = self._get_current_user()
            if not user:
                self._send_json({"authenticated": False}, 401)
                return
            self._send_json({"authenticated": True, "user": serialize_user(user)})
            return

        if path == "/api/tasks":
            user = self._get_current_user()
            if not user:
                self._send_json({"error": "Non autenticato"}, 401)
                return

            conn = get_db()
            cur = conn.cursor()
            work_date = qs.get("date", [None])[0]
            show_all_dates = qs.get("all_dates", ["false"])[0] == "true"
            uid = user["id"]

            if show_all_dates or not work_date:
                cur.execute("""
                    SELECT * FROM tasks
                    WHERE user_id = ? OR user_id IS NULL
                    ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, id DESC
                """, (uid,))
            else:
                include_carryover = qs.get("carryover", ["true"])[0] == "true"
                if include_carryover:
                    cur.execute("""
                        SELECT * FROM tasks
                        WHERE (user_id = ? OR user_id IS NULL)
                          AND (work_date = ? OR (work_date < ? AND status != 'resolved'))
                        ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, id DESC
                    """, (uid, work_date, work_date))
                else:
                    cur.execute("""
                        SELECT * FROM tasks
                        WHERE (user_id = ? OR user_id IS NULL)
                          AND work_date = ?
                        ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, id DESC
                    """, (uid, work_date))

            rows = cur.fetchall()
            tasks = []
            for r in rows:
                cur.execute("SELECT * FROM activity_logs WHERE task_id = ? ORDER BY id DESC", (r["id"],))
                logs = [dict(l) for l in cur.fetchall()]
                tasks.append(serialize_task(r, logs))
            conn.close()
            self._send_json({"tasks": tasks})
            return

        if path == "/api/templates":
            user = self._get_current_user()
            if not user:
                self._send_json({"error": "Non autenticato"}, 401)
                return
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM templates WHERE user_id IS NULL OR user_id = ? ORDER BY id ASC", (user["id"],))
            templates = [dict(r) for r in cur.fetchall()]
            conn.close()
            self._send_json({"templates": templates})
            return

        # Serve static files
        self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()

        # --- AUTH ENDPOINTS ---
        if path == "/api/auth/register":
            email = (body.get("email") or "").strip().lower()
            password = body.get("password") or ""
            full_name = (body.get("full_name") or "").strip()
            role = (body.get("role") or "Operatore Help Desk").strip()
            theme = body.get("theme_preference") or "dark"

            if not email or "@" not in email:
                self._send_json({"error": "Inserisci un indirizzo email valido."}, 400)
                return
            if len(password) < 4:
                self._send_json({"error": "La password deve contenere almeno 4 caratteri."}, 400)
                return
            if not full_name:
                full_name = email.split("@")[0].capitalize()

            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT id FROM users WHERE email = ?", (email,))
            if cur.fetchone():
                conn.close()
                self._send_json({"error": "Questa email è già registrata. Effettua il login."}, 409)
                return

            pwd_hash, pwd_salt = hash_password(password)
            now_iso = datetime.datetime.now().isoformat(timespec="seconds")
            cur.execute("""
                INSERT INTO users (email, full_name, role, password_hash, password_salt, theme_preference, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (email, full_name, role, pwd_hash, pwd_salt, theme, now_iso))
            user_id = cur.lastrowid
            token = self._create_session(conn, user_id)

            cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            user_row = cur.fetchone()
            conn.close()
            self._send_json({"token": token, "user": serialize_user(user_row)}, 201)
            return

        if path == "/api/auth/login":
            email = (body.get("email") or "").strip().lower()
            password = body.get("password") or ""

            if not email or not password:
                self._send_json({"error": "Inserisci email e password."}, 400)
                return

            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM users WHERE email = ?", (email,))
            user_row = cur.fetchone()
            if not user_row or not verify_password(password, user_row["password_hash"], user_row["password_salt"]):
                conn.close()
                self._send_json({"error": "Credenziali non valide. Controlla email o password."}, 401)
                return

            token = self._create_session(conn, user_row["id"])
            conn.close()
            self._send_json({"token": token, "user": serialize_user(user_row)})
            return

        if path == "/api/auth/logout":
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:].strip()
                conn = get_db()
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                conn.close()
            self._send_json({"ok": True})
            return

        # --- PROTECTED ENDPOINTS ---
        user = self._get_current_user()
        if not user:
            self._send_json({"error": "Non autenticato"}, 401)
            return

        if path == "/api/tasks":
            conn = get_db()
            cur = conn.cursor()
            now = datetime.datetime.now()
            now_iso = now.isoformat(timespec='seconds')

            priority = body.get("priority", "P3")
            sla_minutes = int(body.get("sla_minutes") or SLA_DEFAULT_MINUTES.get(priority, 480))
            sla_deadline = (now + datetime.timedelta(minutes=sla_minutes)).isoformat(timespec='seconds')

            ticket_id = (body.get("ticket_id") or "").strip()
            if not ticket_id:
                cur.execute("SELECT COUNT(*) as cnt FROM tasks")
                next_num = 4091 + cur.fetchone()["cnt"]
                ticket_id = f"INC-{next_num}"

            title = (body.get("title") or "Nuova richiesta di supporto").strip()
            description = (body.get("description") or "").strip()
            requester_name = (body.get("requester_name") or "").strip()
            requester_dept = (body.get("requester_dept") or "").strip()
            category = body.get("category") or "Software"
            status = body.get("status") or "todo"
            work_date = body.get("work_date") or now.strftime("%Y-%m-%d")

            cur.execute("""
                INSERT INTO tasks (
                    user_id, ticket_id, title, description, requester_name, requester_dept,
                    category, priority, status, created_at, sla_deadline,
                    time_spent_seconds, work_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """, (
                user["id"], ticket_id, title, description, requester_name, requester_dept,
                category, priority, status, now_iso, sla_deadline, work_date
            ))
            task_id = cur.lastrowid

            cur.execute("""
                INSERT INTO activity_logs (task_id, note, log_type, created_at)
                VALUES (?, ?, 'system', ?)
            """, (task_id, f"Ticket {ticket_id} creato da {user['full_name']} con priorità {priority} (SLA {sla_minutes} min)", now_iso))

            conn.commit()
            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            row = cur.fetchone()
            cur.execute("SELECT * FROM activity_logs WHERE task_id = ? ORDER BY id DESC", (task_id,))
            logs = [dict(l) for l in cur.fetchall()]
            conn.close()
            self._send_json({"task": serialize_task(row, logs)}, 201)
            return

        if path.startswith("/api/tasks/") and path.endswith("/timer"):
            parts = path.strip("/").split("/")
            task_id = int(parts[2])
            action = body.get("action", "toggle")
            now = datetime.datetime.now()
            now_iso = now.isoformat(timespec='seconds')

            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            row = cur.fetchone()
            if not row:
                conn.close()
                self._send_json({"error": "Task non trovato"}, 404)
                return

            timer_started_at = row["timer_started_at"]
            time_spent = row["time_spent_seconds"] or 0
            status = row["status"]

            if action == "add_manual":
                minutes_to_add = int(body.get("minutes", 0))
                time_spent = max(0, time_spent + (minutes_to_add * 60))
                cur.execute("UPDATE tasks SET time_spent_seconds = ? WHERE id = ?", (time_spent, task_id))
                cur.execute("""
                    INSERT INTO activity_logs (task_id, note, log_type, created_at)
                    VALUES (?, ?, 'system', ?)
                """, (task_id, f"Aggiunti manualmente {minutes_to_add} min al timer", now_iso))
            else:
                should_start = (action == "start") or (action == "toggle" and not timer_started_at)
                if should_start:
                    if body.get("exclusive", True):
                        cur.execute("""
                            SELECT id, timer_started_at, time_spent_seconds FROM tasks
                            WHERE timer_started_at IS NOT NULL AND id != ? AND (user_id = ? OR user_id IS NULL)
                        """, (task_id, user["id"]))
                        for other in cur.fetchall():
                            try:
                                st = datetime.datetime.fromisoformat(other["timer_started_at"])
                                diff = max(0, int((now - st).total_seconds()))
                            except ValueError:
                                diff = 0
                            cur.execute("UPDATE tasks SET time_spent_seconds = ?, timer_started_at = NULL WHERE id = ?",
                                        ((other["time_spent_seconds"] or 0) + diff, other["id"]))

                    new_status = "in_progress" if status == "todo" else status
                    cur.execute("UPDATE tasks SET timer_started_at = ?, status = ? WHERE id = ?", (now_iso, new_status, task_id))
                else:
                    if timer_started_at:
                        try:
                            st = datetime.datetime.fromisoformat(timer_started_at)
                            diff = max(0, int((now - st).total_seconds()))
                        except ValueError:
                            diff = 0
                        time_spent += diff
                    cur.execute("UPDATE tasks SET time_spent_seconds = ?, timer_started_at = NULL WHERE id = ?", (time_spent, task_id))

            conn.commit()
            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            updated = cur.fetchone()
            cur.execute("SELECT * FROM activity_logs WHERE task_id = ? ORDER BY id DESC", (task_id,))
            logs = [dict(l) for l in cur.fetchall()]
            conn.close()
            self._send_json({"task": serialize_task(updated, logs)})
            return

        if path.startswith("/api/tasks/") and path.endswith("/logs"):
            parts = path.strip("/").split("/")
            task_id = int(parts[2])
            note = (body.get("note") or "").strip()
            log_type = body.get("log_type", "note")
            if not note:
                self._send_json({"error": "Nota vuota"}, 400)
                return

            now_iso = datetime.datetime.now().isoformat(timespec='seconds')
            conn = get_db()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO activity_logs (task_id, note, log_type, created_at)
                VALUES (?, ?, ?, ?)
            """, (task_id, note, log_type, now_iso))
            conn.commit()

            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            updated = cur.fetchone()
            cur.execute("SELECT * FROM activity_logs WHERE task_id = ? ORDER BY id DESC", (task_id,))
            logs = [dict(l) for l in cur.fetchall()]
            conn.close()
            self._send_json({"task": serialize_task(updated, logs)}, 201)
            return

        if path == "/api/templates":
            title = (body.get("title") or "").strip()
            category = (body.get("category") or "Generale").strip()
            content = (body.get("content") or "").strip()
            if not title or not content:
                self._send_json({"error": "Titolo e contenuto obbligatori"}, 400)
                return
            conn = get_db()
            cur = conn.cursor()
            cur.execute("INSERT INTO templates (user_id, title, category, content) VALUES (?, ?, ?, ?)", (user["id"], title, category, content))
            conn.commit()
            cur.execute("SELECT * FROM templates WHERE user_id IS NULL OR user_id = ? ORDER BY id ASC", (user["id"],))
            templates = [dict(r) for r in cur.fetchall()]
            conn.close()
            self._send_json({"templates": templates}, 201)
            return

        self._send_json({"error": "Endpoint non trovato"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()

        user = self._get_current_user()
        if not user:
            self._send_json({"error": "Non autenticato"}, 401)
            return

        if path == "/api/auth/theme":
            theme = body.get("theme_preference", "dark")
            if theme not in ("dark", "light"):
                theme = "dark"
            conn = get_db()
            conn.execute("UPDATE users SET theme_preference = ? WHERE id = ?", (theme, user["id"]))
            conn.commit()
            cur = conn.cursor()
            cur.execute("SELECT * FROM users WHERE id = ?", (user["id"],))
            updated_user = cur.fetchone()
            conn.close()
            self._send_json({"user": serialize_user(updated_user)})
            return

        if path.startswith("/api/tasks/"):
            parts = path.strip("/").split("/")
            task_id = int(parts[2])
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            row = cur.fetchone()
            if not row:
                conn.close()
                self._send_json({"error": "Task non trovato"}, 404)
                return

            now = datetime.datetime.now()
            now_iso = now.isoformat(timespec='seconds')

            fields = [
                "ticket_id", "title", "description", "requester_name",
                "requester_dept", "category", "priority", "status", "sla_deadline", "work_date"
            ]
            updates = {}
            for f in fields:
                if f in body:
                    updates[f] = body[f]

            old_status = row["status"]
            new_status = updates.get("status", old_status)

            if "priority" in updates and updates["priority"] != row["priority"] and "sla_deadline" not in updates:
                try:
                    created_dt = datetime.datetime.fromisoformat(row["created_at"])
                except ValueError:
                    created_dt = now
                mins = SLA_DEFAULT_MINUTES.get(updates["priority"], 480)
                updates["sla_deadline"] = (created_dt + datetime.timedelta(minutes=mins)).isoformat(timespec='seconds')

            if new_status != old_status:
                status_labels = {
                    "todo": "Da fare",
                    "in_progress": "In lavorazione",
                    "waiting": "In attesa utente/fornitore",
                    "resolved": "Risolto"
                }
                cur.execute("""
                    INSERT INTO activity_logs (task_id, note, log_type, created_at)
                    VALUES (?, ?, 'status', ?)
                """, (task_id, f"Stato cambiato: {status_labels.get(old_status, old_status)} → {status_labels.get(new_status, new_status)}", now_iso))

                if new_status == "resolved":
                    updates["resolved_at"] = now_iso
                    if row["timer_started_at"]:
                        try:
                            st = datetime.datetime.fromisoformat(row["timer_started_at"])
                            diff = max(0, int((now - st).total_seconds()))
                        except ValueError:
                            diff = 0
                        updates["time_spent_seconds"] = (row["time_spent_seconds"] or 0) + diff
                        updates["timer_started_at"] = None
                elif old_status == "resolved" and new_status != "resolved":
                    updates["resolved_at"] = None

            if updates:
                set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
                values = list(updates.values()) + [task_id]
                cur.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)
                conn.commit()

            cur.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            updated = cur.fetchone()
            cur.execute("SELECT * FROM activity_logs WHERE task_id = ? ORDER BY id DESC", (task_id,))
            logs = [dict(l) for l in cur.fetchall()]
            conn.close()
            self._send_json({"task": serialize_task(updated, logs)})
            return

        self._send_json({"error": "Endpoint non trovato"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        user = self._get_current_user()
        if not user:
            self._send_json({"error": "Non autenticato"}, 401)
            return

        if path.startswith("/api/tasks/"):
            parts = path.strip("/").split("/")
            task_id = int(parts[2])
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            conn.commit()
            conn.close()
            self._send_json({"ok": True})
            return

        if path.startswith("/api/templates/"):
            parts = path.strip("/").split("/")
            tpl_id = int(parts[2])
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM templates WHERE id = ?", (tpl_id,))
            conn.commit()
            cur.execute("SELECT * FROM templates WHERE user_id IS NULL OR user_id = ? ORDER BY id ASC", (user["id"],))
            templates = [dict(r) for r in cur.fetchall()]
            conn.close()
            self._send_json({"templates": templates})
            return

        self._send_json({"error": "Endpoint non trovato"}, 404)


def run_server(port=8765):
    init_db()
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, HelpDeskHandler)
    print(f"============================================================")
    print(f" Help Desk Task & SLA Tracker avviato con successo!")
    print(f" URL Applicazione: http://127.0.0.1:{port}")
    print(f" Database SQLite:  {DB_PATH}")
    print(f"============================================================")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nChiusura server...")
        httpd.server_close()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    run_server(port)
