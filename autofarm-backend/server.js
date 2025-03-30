// server.js
const express = require('express');
const cors = require('cors');
const db = require('./database.js'); // Importa a conexão do banco já inicializado

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- SIMULAÇÃO DINÂMICA E ARMAZENAMENTO DE HISTÓRICO ---
const SIMULATION_INTERVAL = 5000; // ms
const MAX_HISTORY_PER_SENSOR = 60; // Número de leituras a manter

function simulateNextValue(currentValue, min, max, maxChange) {
    const baseValue = (currentValue === null || currentValue === undefined) ? (min + (max - min) / 2) : currentValue;
    let change = (Math.random() * 2 * maxChange) - maxChange;
    let newValue = baseValue + change;
    newValue = Math.max(min, Math.min(max, newValue));
    const decimals = (maxChange < 1 || min < 1 || max < 1) ? 1 : 0; // Ajusta decimais para pH/Temp
    return parseFloat(newValue.toFixed(decimals));
}

// Função auxiliar para buscar o último valor lido de um sensor específico para uma unidade
function getLatestReading(unitId, sensorType) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT value FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp DESC LIMIT 1`;
        db.get(sql, [unitId, sensorType], (err, row) => {
            if (err) { reject(err); }
            else { resolve(row ? row.value : null); }
        });
    });
}

// Função para registrar um evento de alerta no histórico
function logAlertHistory(alertId, alertName, unitId, triggeredValue, actionTaken = null, message = null) {
    console.log(`[Histórico] Logando alerta: ID=${alertId}, Nome=${alertName}, Valor=${triggeredValue}, Ação=${actionTaken}`);
    const sql = `INSERT INTO alert_history (alert_id, alert_name, unit_id, triggered_value, action_taken, message) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(sql, [alertId, alertName, unitId, String(triggeredValue), actionTaken, message], (err) => {
        if (err) {
            console.error(`[Histórico] Erro ao logar alerta ID ${alertId}:`, err.message);
        }
    });
}

// Função principal de simulação e verificação de alertas
async function runSimulationAndChecks() {
    const sqlUnits = "SELECT id FROM unidades";
    db.all(sqlUnits, [], async (err, units) => { // Usa async aqui
        if (err || !units || units.length === 0) {
            if(err) console.error("[Simulação] Erro ao buscar unidades:", err.message);
            return;
        }

        const activeAlertsSql = "SELECT * FROM alertas WHERE is_active = 1";
        db.all(activeAlertsSql, [], async (alertErr, activeAlerts) => { // Usa async
            if (alertErr) {
                console.error("[Simulação] Erro ao buscar alertas ativos:", alertErr.message);
                return; // Não continua se não puder buscar alertas
            }

            // Guarda os novos valores simulados para cada unidade
            const newReadingsPerUnit = {};

            // Simula novos valores para cada unidade/sensor
            for (const unit of units) {
                const unitId = unit.id;
                newReadingsPerUnit[unitId] = {};
                const sensorsToSimulate = ['humidity', 'temperature', 'lighting', 'co2', 'ph'];
                const now = new Date().toISOString();

                for (const sensorType of sensorsToSimulate) {
                    try {
                        const currentValue = await getLatestReading(unitId, sensorType);
                        let min, max, maxChange;
                        switch(sensorType) {
                             case 'humidity':    min = 40; max = 90; maxChange = 1.5; break;
                             case 'temperature': min = 15; max = 30; maxChange = 0.3; break;
                             case 'lighting':    min = 50; max = 100; maxChange = 3; break;
                             case 'co2':         min = 350; max = 1200; maxChange = 15; break;
                             case 'ph':          min = 5.0; max = 7.5; maxChange = 0.1; break;
                             default:            min = 0; max = 100; maxChange = 1;
                        }
                        const newValue = simulateNextValue(currentValue, min, max, maxChange);
                        newReadingsPerUnit[unitId][sensorType] = newValue; // Guarda novo valor

                        // Insere nova leitura no banco
                        const sqlInsert = `INSERT INTO leituras (unit_id, sensor_type, value, timestamp) VALUES (?, ?, ?, ?)`;
                        db.run(sqlInsert, [unitId, sensorType, newValue, now], function(errInsert) {
                            if (errInsert) { console.error(`[Simulação] Erro I1 (${sensorType}) U${unitId}:`, errInsert.message); }
                            else {
                                // Apaga leituras antigas (mantém MAX_HISTORY_PER_SENSOR)
                                const sqlDeleteOld = `DELETE FROM leituras WHERE id IN ( SELECT id FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp ASC LIMIT MAX(0, (SELECT COUNT(*) FROM leituras WHERE unit_id = ? AND sensor_type = ?) - ?) )`;
                                db.run(sqlDeleteOld, [unitId, sensorType, unitId, sensorType, MAX_HISTORY_PER_SENSOR], (errDelete) => {
                                    if(errDelete) console.error("[Simulação] Erro D1:", errDelete.message);
                                });
                            }
                        });
                    } catch (readErr) {
                         console.error(`[Simulação] Erro ao ler último valor (${sensorType}) U${unitId}:`, readErr.message);
                    }
                } // Fim loop sensores
            } // Fim loop unidades (simulação)

            // --- !! INÍCIO: Lógica de Verificação e Histórico de Alertas !! ---
            // Agora que simulamos todos os valores, verificamos os alertas
            if (activeAlerts && activeAlerts.length > 0) {
                for (const unit of units) {
                    const unitId = unit.id;
                    const currentReadings = newReadingsPerUnit[unitId]; // Pega leituras simuladas para esta unidade

                    activeAlerts.forEach(alert => {
                        // Verifica se o alerta se aplica a um sensor desta unidade
                        if (alert.device.includes('_sensor') && currentReadings) {
                            const sensorType = alert.device.replace('_sensor', '');
                            const currentValue = currentReadings[sensorType];
                            const limit = alert.limit_value;
                            let conditionMet = false;

                            if (currentValue !== undefined && limit !== null) {
                                switch (alert.condition) {
                                    case '>': conditionMet = currentValue > limit; break;
                                    case '<': conditionMet = currentValue < limit; break;
                                    case '=': conditionMet = currentValue == limit; break;
                                    // Adicionar outras condições se necessário
                                }
                            }

                            if (conditionMet) {
                                // !! Alerta Disparado !!
                                console.log(`ALERTA DISPARADO! ID: ${alert.id}, Nome: ${alert.name}, Unidade: ${unitId}, Cond: ${sensorType} ${alert.condition} ${limit}, Valor: ${currentValue}`);

                                // TODO: Implementar a 'action' real aqui (ligar/desligar algo via API/MQTT etc.)
                                let actionTakenDescription = 'notified'; // Padrão
                                if (alert.action) {
                                    try {
                                        const actionObj = JSON.parse(alert.action);
                                        // Exemplo: triggerActuator(actionObj.device, actionObj.state);
                                        actionTakenDescription = `${actionObj.device}_${actionObj.state}`;
                                        console.log(`   -> Ação: ${actionTakenDescription}`);
                                    } catch (e) { console.error("Erro ao processar ação do alerta:", e); }
                                }

                                // Loga no histórico
                                logAlertHistory(alert.id, alert.name, unitId, currentValue, actionTakenDescription);
                            }
                        }
                        // TODO: Adicionar lógica para alertas baseados em atuadores ('on'/'off') se necessário
                    });
                } // Fim loop unidades (verificação)
            }
            // --- !! FIM: Lógica de Verificação e Histórico de Alertas !! ---

        }); // Fim db.all(activeAlerts)
    }); // Fim db.all(units)
}

// Inicia a simulação
let simulationIntervalId = setInterval(runSimulationAndChecks, SIMULATION_INTERVAL);
console.log(`[Simulação] Iniciada. Novos dados a cada ${SIMULATION_INTERVAL / 1000} segundos.`);
console.log(`[Simulação] Histórico mantido para as últimas ${MAX_HISTORY_PER_SENSOR} leituras por sensor/unidade.`);

// --- ROTAS DA API ---

app.get('/', (req, res) => res.send('Backend AutoFarm v2.11 está rodando!'));

// GET /api/units (Mantido como no seu exemplo)
app.get('/api/units', (req, res) => {
    const sql = "SELECT * FROM unidades ORDER BY name";
     db.all(sql, [], (err, rows) => {
         if (err) { console.error("Erro ao buscar unidades:", err.message); res.status(500).json({ error: err.message }); return; }
         const unitsFrontend = rows.map(unit => ({
             id: unit.id, name: unit.name,
             // Placeholder para dados atuais - idealmente seria buscado das últimas leituras
             humidity: null, temperature: null, lighting: null, co2: null, ph: null,
             light_on: false, hum_on: false, temp_on: false, co2_on: false, ph_on: false,
             area: unit.area ? `${unit.area} m²` : 'N/A', type: unit.type || 'N/A',
             sensors: unit.sensors ? JSON.parse(unit.sensors) : [],
             lighting_level_ideal: unit.lighting_level_ideal // Usando nome correto da coluna
         }));
         // Otimização: Buscar últimas leituras reais em vez de placeholder
         // (Isso pode ser feito aqui com Promise.all ou deixar o frontend buscar via /current_readings)
         res.json(unitsFrontend);
     });
});

// POST /api/units (Mantido como no seu exemplo)
app.post('/api/units', (req, res) => {
     const { name, area, type, lighting_level, sensors } = req.body;
     if (!name || !area || !type || lighting_level === undefined || !sensors) { return res.status(400).json({ error: "Dados incompletos." }); }
     const sensorsJson = JSON.stringify(sensors || []);
     const sql = `INSERT INTO unidades (name, area, type, lighting_level_ideal, sensors) VALUES (?, ?, ?, ?, ?)`; // Usa nome correto
     db.run(sql, [name, area, type, lighting_level, sensorsJson], function (err) {
         if (err) { console.error("Erro I2:", err.message); res.status(500).json({ error: err.message }); return; }
         res.status(201).json({ message: "Unidade criada!", id: this.lastID, name: name });
     });
});

// PUT /api/units/:id (Mantido como no seu exemplo, corrigido nome coluna)
app.put('/api/units/:id', (req, res) => {
    const { name, area, type, lighting_level, sensors } = req.body;
    const unitId = req.params.id;
    if (!name || !area || !type || lighting_level === undefined || !sensors) { return res.status(400).json({ error: "Dados incompletos." }); }
    const sensorNames = Array.isArray(sensors) ? sensors.map(s => typeof s === 'object' && s !== null ? s.name || s.value : s).filter(s => s) : [];
    const sensorsJson = JSON.stringify(sensorNames);
    const sql = `UPDATE unidades SET name = ?, area = ?, type = ?, lighting_level_ideal = ?, sensors = ? WHERE id = ?`; // Usa nome correto
    db.run(sql, [name, area, type, lighting_level, sensorsJson, unitId], function (err) {
        if (err) { console.error("Erro U1:", err.message); res.status(500).json({ error: err.message }); return; }
        if (this.changes === 0) { return res.status(404).json({ error: `Unidade ${unitId} não encontrada.`}); }
        res.json({ message: `Unidade ${unitId} atualizada!`, changes: this.changes });
    });
});

// DELETE /api/units/:id (Mantido como no seu exemplo)
app.delete('/api/units/:id', (req, res) => {
    const unitId = req.params.id;
    const sql = `DELETE FROM unidades WHERE id = ?`;
    db.run(sql, [unitId], function (err) {
        if (err) { console.error("Erro D2:", err.message); res.status(500).json({ error: err.message }); return; }
        if (this.changes === 0) { return res.status(404).json({ error: `Unidade ${unitId} não encontrada.`}); }
        // Leituras associadas são deletadas via ON DELETE CASCADE
        res.json({ message: `Unidade ${unitId} removida!`, changes: this.changes });
    });
});

// GET /api/units/current_readings (Mantido como no seu exemplo)
app.get('/api/units/current_readings', (req, res) => {
    const sql = `SELECT l.unit_id, l.sensor_type, l.value FROM leituras l INNER JOIN ( SELECT unit_id, sensor_type, MAX(timestamp) AS max_ts FROM leituras GROUP BY unit_id, sensor_type ) latest ON l.unit_id = latest.unit_id AND l.sensor_type = latest.sensor_type AND l.timestamp = latest.max_ts ORDER BY l.unit_id, l.sensor_type;`;
     db.all(sql, [], (err, rows) => {
         if (err) { console.error("Erro G1:", err.message); res.status(500).json({ error: err.message }); return; }
         const formattedData = {};
         rows.forEach(row => {
             if (!formattedData[row.unit_id]) formattedData[row.unit_id] = {};
             let formattedValue = row.value;
             // Ajusta formatação conforme tipo (opcional, mas melhora consistência)
             if (row.sensor_type === 'ph') formattedValue = parseFloat(row.value.toFixed(1));
             else if (['temperature', 'humidity', 'lighting'].includes(row.sensor_type)) formattedValue = parseFloat(row.value.toFixed(1));
             else if (row.sensor_type === 'co2') formattedValue = parseFloat(row.value.toFixed(0));
             formattedData[row.unit_id][row.sensor_type] = formattedValue;
         });
         res.json(formattedData);
     });
});

// GET /api/units/:id/readings (Mantido como no seu exemplo)
app.get('/api/units/:id/readings', (req, res) => {
     const unitId = req.params.id; const sensorType = req.query.sensor; const limit = parseInt(req.query.limit, 10) || MAX_HISTORY_PER_SENSOR;
     if (!sensorType) return res.status(400).json({ error: "Parâmetro 'sensor' é obrigatório." });
     const validSensors = ['humidity', 'temperature', 'lighting', 'co2', 'ph'];
     if (!validSensors.includes(sensorType)) return res.status(400).json({ error: "Tipo de sensor inválido." });
     const sql = `SELECT value, timestamp FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp DESC LIMIT ?`;
     db.all(sql, [unitId, sensorType, limit], (err, rows) => {
         if (err) { console.error(`Erro G2 (${sensorType}) U${unitId}:`, err.message); res.status(500).json({ error: err.message }); return; }
         res.json(rows.reverse()); // Envia em ordem cronológica (do mais antigo pro mais novo)
     });
});

// --- ROTAS DE ALERTAS (Atualizadas v2.11) ---

// POST /api/alerts (Criação - Corrigido)
app.post('/api/alerts', (req, res) => {
    const { name, device, condition, limit, action } = req.body;
    // Validação básica
    if (!name || !device || !condition || (limit === undefined && limit === null && !['on', 'off'].includes(condition))) {
        return res.status(400).json({ error: "Dados incompletos para criar alerta." });
    }
    const limitValue = (limit !== undefined && limit !== null && limit !== '') ? parseFloat(limit) : null;
    // Valida se limite é necessário
    if (limitValue === null && !['on', 'off'].includes(condition)) {
        return res.status(400).json({ error: "Valor limite é necessário para esta condição." });
    }
    const actionJson = action ? JSON.stringify(action) : null;
    const isActiveValue = 1; // Novos alertas começam ativos

    const sql = `INSERT INTO alertas (name, device, condition, limit_value, action, is_active) VALUES (?, ?, ?, ?, ?, ?)`;

    db.run(sql, [name, device, condition, limitValue, actionJson, isActiveValue], function (err) {
        if (err) {
            // Verifica erro específico de constraint (ex: nome duplicado, se houver UNIQUE)
            if (err.message.includes('SQLITE_CONSTRAINT')) {
                 return res.status(409).json({ error: `Erro de restrição: ${err.message}` });
            }
            console.error("Erro ao criar alerta:", err.message);
            res.status(500).json({ error: `Erro interno ao criar alerta: ${err.message}` });
            return;
        }
        // Retorna o alerta criado com o ID e o estado ativo
        res.status(201).json({
            message: "Alerta criado com sucesso!",
            id: this.lastID,
            name, device, condition, limit_value: limitValue, action, is_active: true // Retorna true
        });
    });
});


// GET /api/alerts - Lista regras (Mantido, já incluia is_active)
app.get('/api/alerts', (req, res) => {
    // Seleciona todos os campos relevantes
    const sql = "SELECT id, name, device, condition, limit_value, action, is_active FROM alertas ORDER BY name ASC";
    db.all(sql, [], (err, rows) => {
        if (err) { console.error("Erro G3:", err.message); res.status(500).json({ error: err.message }); return; }
        // Processa o campo 'action' e garante que is_active seja booleano
        const alerts = rows.map(alert => ({
            ...alert,
            action: alert.action ? JSON.parse(alert.action) : null,
            is_active: alert.is_active === 1 // Converte 1/0 para true/false
        }));
        res.json(alerts);
    });
});

// PATCH /api/alerts/:id - Ativa/Desativa (Implementado Corretamente)
app.patch('/api/alerts/:id', (req, res) => {
    const { is_active } = req.body; // Espera um booleano no corpo da requisição
    const alertId = req.params.id;

    if (typeof is_active !== 'boolean') {
        return res.status(400).json({ "error": "Campo 'is_active' (true/false) é obrigatório." });
    }

    const isActiveDbValue = is_active ? 1 : 0; // Converte para 1 ou 0 para o banco
    const sql = `UPDATE alertas SET is_active = ? WHERE id = ?`;

    db.run(sql, [isActiveDbValue, alertId], function (err) {
        if (err) {
            console.error(`Erro ao atualizar alerta ${alertId}:`, err.message);
            res.status(500).json({ "error": err.message });
            return;
        }
        if (this.changes === 0) {
            res.status(404).json({ "error": `Alerta com ID ${alertId} não encontrado.` });
            return;
        }
        console.log(`Alerta ${alertId} atualizado para is_active = ${is_active}`);
        res.json({
            message: `Alerta ${alertId} ${is_active ? 'ativado' : 'desativado'} com sucesso!`,
            changes: this.changes
        });
    });
});


// DELETE /api/alerts/:id (Mantido - ON DELETE CASCADE cuida do histórico)
app.delete('/api/alerts/:id', (req, res) => {
    const alertId = req.params.id;
    const sql = "DELETE FROM alertas WHERE id = ?";
    db.run(sql, [alertId], function(err) {
        if (err) { console.error("Erro D3:", err.message); res.status(500).json({ error: err.message }); return; }
        if (this.changes === 0) { return res.status(404).json({ error: `Alerta ${alertId} não encontrado.` }); }
        console.log(`Alerta ${alertId} deletado.`);
        res.json({ message: `Alerta ${alertId} deletado!`, changes: this.changes });
    });
});


// --- Rota Histórico de Alertas (Implementada) ---

// GET /api/alert_history - Busca histórico real
app.get('/api/alert_history', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50; // Limite padrão de 50
    const sql = `
        SELECT
            h.id, h.alert_id, h.timestamp, h.triggered_value, h.action_taken, h.message,
            h.alert_name -- Usando o nome armazenado no histórico
        FROM alert_history h
        ORDER BY h.timestamp DESC
        LIMIT ?
    `;
    db.all(sql, [limit], (err, rows) => {
        if (err) {
            console.error("Erro ao buscar histórico de alertas:", err.message);
            res.status(500).json({ "error": err.message });
            return;
        }
        // Formata a data para um formato mais legível se necessário, ou deixa ISO
        // rows = rows.map(row => ({...row, timestamp: new Date(row.timestamp).toLocaleString('pt-BR') }));
        res.json(rows);
    });
});


// --- FIM DAS ROTAS ---

app.listen(PORT, () => {
    console.log(`Servidor backend v2.11 rodando em http://localhost:${PORT}`);
});

// Garante que a simulação e o banco sejam fechados corretamente
process.on('SIGINT', () => {
    console.log('\nFechando simulação e banco de dados...');
    clearInterval(simulationIntervalId);
    db.close((err) => {
        if (err) console.error('Erro ao fechar DB', err.message);
        else console.log('Conexão DB fechada.');
        process.exit(0);
    });
});