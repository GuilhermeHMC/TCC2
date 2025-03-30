// database.js
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./autofarm.db', (err) => {
    if (err) {
        console.error("Erro ao conectar ao banco de dados:", err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        criarTabelasIniciais();
    }
});

function criarTabelasIniciais() {
    db.serialize(() => {
        // Tabela de Unidades
        db.run(`CREATE TABLE IF NOT EXISTS unidades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            area TEXT,
            type TEXT,
            lighting_level_ideal INTEGER,
            sensors TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Erro ao criar tabela unidades:", err.message);
            else console.log("Tabela 'unidades' verificada/criada.");
        });

        // Tabela de Leituras (Histórico)
        db.run(`CREATE TABLE IF NOT EXISTS leituras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            unit_id INTEGER NOT NULL,
            sensor_type TEXT NOT NULL,
            value REAL NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (unit_id) REFERENCES unidades (id) ON DELETE CASCADE
        )`, (err) => {
            if (err) console.error("Erro ao criar tabela leituras:", err.message);
            else console.log("Tabela 'leituras' verificada/criada.");
        });

        // Tabela de Alertas (Regras) - Adicionado is_active
        db.run(`CREATE TABLE IF NOT EXISTS alertas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            device TEXT,
            condition TEXT,
            limit_value REAL,
            action TEXT,
            is_active INTEGER DEFAULT 1, /* 1 para ativo, 0 para inativo */
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
             if (err) console.error("Erro ao criar tabela alertas:", err.message);
             else console.log("Tabela 'alertas' verificada/criada (com is_active).");
        });

        // Tabela de Histórico de Alertas Disparados (Nova)
        db.run(`CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            unit_id INTEGER, /* Opcional: unidade específica se aplicável */
            triggered_value REAL, /* Valor que disparou o alerta */
            message TEXT, /* Mensagem do alerta disparado */
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alertas (id) ON DELETE CASCADE,
            FOREIGN KEY (unit_id) REFERENCES unidades (id) ON DELETE SET NULL
        )`, (err) => {
             if (err) console.error("Erro ao criar tabela alert_history:", err.message);
             else console.log("Tabela 'alert_history' verificada/criada.");
        });

        // Índices (Opcional, mas recomendado)
        db.run(`CREATE INDEX IF NOT EXISTS idx_leituras_unit_sensor_time ON leituras (unit_id, sensor_type, timestamp DESC)`, (err) => {
             if (err) console.warn("Aviso: Não foi possível criar índice em 'leituras'.", err?.message);
             else console.log("Índice em 'leituras' verificado/criado.");
        });
         db.run(`CREATE INDEX IF NOT EXISTS idx_alert_history_time ON alert_history (timestamp DESC)`, (err) => {
             if (err) console.warn("Aviso: Não foi possível criar índice em 'alert_history'.", err?.message);
             else console.log("Índice em 'alert_history' verificado/criado.");
        });
    });
}

module.exports = db;