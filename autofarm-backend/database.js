// database.js
const sqlite3 = require('sqlite3').verbose();
const DB_PATH = './autofarm.db'; // Garanta que este é o caminho correto

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("Erro ao conectar ao banco de dados:", err.message);
        throw err; // Importante parar se não conectar
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        initializeDatabase(); // Chama a inicialização/verificação
    }
});

// Função para verificar e adicionar coluna se necessário
// (Útil para atualizar schema existente sem apagar dados)
function checkAndAddColumn(tableName, columnName, columnDefinition) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
            if (err) {
                return reject(`Erro ao verificar colunas de ${tableName}: ${err.message}`);
            }
            const columnExists = columns.some(col => col.name === columnName);
            if (!columnExists) {
                console.log(`Adicionando coluna ${columnName} à tabela ${tableName}...`);
                db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`, (alterErr) => {
                    if (alterErr) {
                        // Não rejeita imediatamente, pode ser erro comum em dev, mas loga
                        console.error(`Erro ao adicionar coluna ${columnName} a ${tableName}: ${alterErr.message}`);
                        resolve(); // Resolve mesmo com erro para não parar tudo, mas logou o erro.
                    } else {
                        console.log(`Coluna ${columnName} adicionada com sucesso a ${tableName}.`);
                        resolve();
                    }
                });
            } else {
                // Coluna já existe, não faz nada
                resolve();
            }
        });
    });
}


async function initializeDatabase() {
    db.serialize(async () => { // Usa async aqui para poder usar await dentro
        console.log("Inicializando/Verificando schema do banco de dados...");

        // Tabela de Unidades (Mantida como no seu exemplo)
        db.run(`CREATE TABLE IF NOT EXISTS unidades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            area TEXT,
            type TEXT,
            lighting_level_ideal INTEGER, /* Renomeado aqui p/ clareza */
            sensors TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Erro ao criar/verificar tabela unidades:", err.message);
            else console.log("Tabela 'unidades' verificada/criada.");
        });

        // Tabela de Leituras (Mantida como no seu exemplo)
        db.run(`CREATE TABLE IF NOT EXISTS leituras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            unit_id INTEGER NOT NULL,
            sensor_type TEXT NOT NULL,
            value REAL NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (unit_id) REFERENCES unidades (id) ON DELETE CASCADE
        )`, (err) => {
            if (err) console.error("Erro ao criar/verificar tabela leituras:", err.message);
            else console.log("Tabela 'leituras' verificada/criada.");
        });

        // Tabela de Alertas (Definição como no seu exemplo, garantindo is_active)
        db.run(`CREATE TABLE IF NOT EXISTS alertas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            device TEXT,
            condition TEXT,
            limit_value REAL,
            action TEXT,
            is_active INTEGER DEFAULT 1, /* Confirmado: 1 para ativo, 0 para inativo */
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, async (err) => { // Usa async para esperar checkAndAddColumn
            if (err) {
                console.error("Erro ao criar/verificar tabela alertas:", err.message);
            } else {
                 console.log("Tabela 'alertas' verificada/criada.");
                 // Tenta adicionar a coluna is_active caso a tabela já exista de uma versão anterior
                 try {
                    await checkAndAddColumn('alertas', 'is_active', 'INTEGER DEFAULT 1');
                 } catch (checkErr) {
                     console.error("Falha ao verificar/adicionar coluna 'is_active':", checkErr);
                 }
            }
        });

        // Tabela de Histórico de Alertas Disparados (Definição como no seu exemplo)
        // Adicionado ON DELETE CASCADE para alert_id
        db.run(`CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            alert_name TEXT, -- Adicionado para facilitar exibição no histórico
            unit_id INTEGER,
            triggered_value TEXT, -- Mudado para TEXT para acomodar 'on'/'off' também
            message TEXT, -- Mantido do seu exemplo, pode não ser usado ainda
            action_taken TEXT, -- Adicionado para registrar ação (ex: 'irrigation_on')
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alertas (id) ON DELETE CASCADE, -- Importante!
            FOREIGN KEY (unit_id) REFERENCES unidades (id) ON DELETE SET NULL
        )`, (err) => {
            if (err) console.error("Erro ao criar/verificar tabela alert_history:", err.message);
            else console.log("Tabela 'alert_history' verificada/criada.");
        });

        // Índices (Mantido)
        db.run(`CREATE INDEX IF NOT EXISTS idx_leituras_unit_sensor_time ON leituras (unit_id, sensor_type, timestamp DESC)`, (err) => {
             if (err) console.warn("Aviso: Não foi possível criar/verificar índice em 'leituras'.", err?.message);
        });
         db.run(`CREATE INDEX IF NOT EXISTS idx_alert_history_time ON alert_history (timestamp DESC)`, (err) => {
             if (err) console.warn("Aviso: Não foi possível criar/verificar índice em 'alert_history'.", err?.message);
         });

        console.log("Schema do banco de dados pronto.");
    });
}

module.exports = db;