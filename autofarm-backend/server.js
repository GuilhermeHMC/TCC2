// server.js
const express = require('express');
const cors = require('cors');
const db = require('./database.js');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- SIMULAÇÃO DINÂMICA E ARMAZENAMENTO DE HISTÓRICO ---
const SIMULATION_INTERVAL = 5000;
const MAX_HISTORY_PER_SENSOR = 60;

function simulateNextValue(currentValue, min, max, maxChange) {
    const baseValue = (currentValue === null || currentValue === undefined) ? (min + (max - min) / 2) : currentValue;
    let change = (Math.random() * 2 * maxChange) - maxChange;
    let newValue = baseValue + change;
    newValue = Math.max(min, Math.min(max, newValue));
    const decimals = (maxChange < 1) ? 1 : 0;
    return parseFloat(newValue.toFixed(decimals));
}

let simulationIntervalId = setInterval(() => {
    const sqlUnits = "SELECT id FROM unidades";
    db.all(sqlUnits, [], (err, units) => {
        if (err || !units || units.length === 0) {
            if(err) console.error("[Simulação] Erro ao buscar unidades:", err.message);
            return;
        }

        units.forEach(unit => {
            const unitId = unit.id;
            const sensorsToSimulate = ['humidity', 'temperature', 'lighting', 'co2', 'ph'];
            const now = new Date().toISOString();

            sensorsToSimulate.forEach(sensorType => {
                const sqlLast = `SELECT value FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp DESC LIMIT 1`;
                db.get(sqlLast, [unitId, sensorType], (errLast, lastReading) => {
                    if (errLast) { console.error(`[Simulação] Erro L1 (${sensorType}) U${unitId}:`, errLast.message); return; }

                    let currentValue = lastReading ? lastReading.value : null;
                    let newValue;
                    let min, max, maxChange;

                    switch(sensorType) {
                        case 'humidity':    min = 40; max = 90; maxChange = 1.5; break;
                        case 'temperature': min = 15; max = 30; maxChange = 0.3; break;
                        case 'lighting':    min = 50; max = 100; maxChange = 3; break;
                        case 'co2':         min = 350; max = 1200; maxChange = 15; break;
                        case 'ph':          min = 5.0; max = 7.5; maxChange = 0.1; break;
                        default:            min = 0; max = 100; maxChange = 1;
                    }
                    newValue = simulateNextValue(currentValue, min, max, maxChange);

                    const sqlInsert = `INSERT INTO leituras (unit_id, sensor_type, value, timestamp) VALUES (?, ?, ?, ?)`;
                    db.run(sqlInsert, [unitId, sensorType, newValue, now], function(errInsert) {
                        if (errInsert) { console.error(`[Simulação] Erro I1 (${sensorType}) U${unitId}:`, errInsert.message); }
                        else {
                            const sqlDeleteOld = `DELETE FROM leituras WHERE id IN ( SELECT id FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp ASC LIMIT MAX(0, (SELECT COUNT(*) FROM leituras WHERE unit_id = ? AND sensor_type = ?) - ?) )`;
                            db.run(sqlDeleteOld, [unitId, sensorType, unitId, sensorType, MAX_HISTORY_PER_SENSOR], (errDelete) => {
                                if(errDelete) console.error("[Simulação] Erro D1:", errDelete.message);
                            });
                        }
                    });
                });
            });
            // --- !! Placeholder para Avaliação de Alertas !! ---
            // Aqui seria o local ideal para, após gerar novos dados,
            // buscar as regras de alerta ATIVAS (is_active=1) e verificar
            // se alguma condição foi atendida pelos novos valores.
            // Se sim, inserir um registro na tabela 'alert_history'.
            // Exemplo muito simplificado (não funcional):
            // evaluateAlertsForUnit(unitId, newReadings); // Chamar função de avaliação
            // --- !! Fim Placeholder !! ---
        });
    });
}, SIMULATION_INTERVAL);

console.log(`[Simulação] Iniciada. Novos dados a cada ${SIMULATION_INTERVAL / 1000} segundos.`);
console.log(`[Simulação] Histórico mantido para as últimas ${MAX_HISTORY_PER_SENSOR} leituras por sensor/unidade.`);

// --- ROTAS DA API ---

app.get('/', (req, res) => res.send('Backend AutoFarm está rodando!'));

// GET /api/units (Para carga inicial)
app.get('/api/units', (req, res) => {
     const sql = "SELECT * FROM unidades ORDER BY name";
     db.all(sql, [], (err, rows) => {
         if (err) { console.error("Erro ao buscar unidades:", err.message); res.status(500).json({ error: err.message }); return; }
         const unitsFrontend = rows.map(unit => ({
             id: unit.id, name: unit.name,
             humidity: Math.floor(Math.random() * 30) + 60, // Placeholder inicial
             temperature: Math.floor(Math.random() * 10) + 18, // Placeholder inicial
             lighting: Math.floor(Math.random() * 30) + 65, // Placeholder inicial
             co2: Math.floor(Math.random() * 150) + 400, // Placeholder inicial
             ph: (Math.random() * 1.5 + 5.5).toFixed(1), // Placeholder inicial
             light_on: Math.random() > 0.5, hum_on: Math.random() > 0.5, temp_on: Math.random() > 0.5,
             co2_on: false, ph_on: false, // Default
             area: unit.area ? `${unit.area} m²` : 'N/A', type: unit.type || 'N/A',
             sensors: unit.sensors ? JSON.parse(unit.sensors) : [],
             lighting_level_ideal: unit.lighting_level_ideal
         }));
         res.json(unitsFrontend);
     });
});

// POST /api/units (Criação)
app.post('/api/units', (req, res) => {
     const { name, area, type, lighting_level, sensors } = req.body;
     if (!name || !area || !type || lighting_level === undefined || !sensors) { return res.status(400).json({ error: "Dados incompletos." }); }
     const sensorsJson = JSON.stringify(sensors || []);
     const sql = `INSERT INTO unidades (name, area, type, lighting_level_ideal, sensors) VALUES (?, ?, ?, ?, ?)`;
     db.run(sql, [name, area, type, lighting_level, sensorsJson], function (err) {
         if (err) { console.error("Erro I2:", err.message); res.status(500).json({ error: err.message }); return; }
         res.status(201).json({ message: "Unidade criada!", id: this.lastID, name: name });
     });
});

 // PUT /api/units/:id (Atualização)
 app.put('/api/units/:id', (req, res) => {
     const { name, area, type, lighting_level, sensors } = req.body;
     const unitId = req.params.id;
     if (!name || !area || !type || lighting_level === undefined || !sensors) { return res.status(400).json({ error: "Dados incompletos." }); }
     const sensorNames = Array.isArray(sensors) ? sensors.map(s => typeof s === 'object' && s !== null ? s.name || s.value : s).filter(s => s) : [];
     const sensorsJson = JSON.stringify(sensorNames);
     const sql = `UPDATE unidades SET name = ?, area = ?, type = ?, lighting_level_ideal = ?, sensors = ? WHERE id = ?`;
     db.run(sql, [name, area, type, lighting_level, sensorsJson, unitId], function (err) {
         if (err) { console.error("Erro U1:", err.message); res.status(500).json({ error: err.message }); return; }
         if (this.changes === 0) { return res.status(404).json({ error: `Unidade ${unitId} não encontrada.`}); }
         res.json({ message: `Unidade ${unitId} atualizada!`, changes: this.changes });
     });
 });

// DELETE /api/units/:id (Deleção)
app.delete('/api/units/:id', (req, res) => {
    const unitId = req.params.id;
    const sql = `DELETE FROM unidades WHERE id = ?`;
    db.run(sql, [unitId], function (err) {
        if (err) { console.error("Erro D2:", err.message); res.status(500).json({ error: err.message }); return; }
        if (this.changes === 0) { return res.status(404).json({ error: `Unidade ${unitId} não encontrada.`}); }
        res.json({ message: `Unidade ${unitId} removida!`, changes: this.changes });
    });
});

// GET /api/units/current_readings (Leituras Atuais)
app.get('/api/units/current_readings', (req, res) => {
    const sql = `SELECT l.unit_id, l.sensor_type, l.value FROM leituras l INNER JOIN ( SELECT unit_id, sensor_type, MAX(timestamp) AS max_ts FROM leituras GROUP BY unit_id, sensor_type ) latest ON l.unit_id = latest.unit_id AND l.sensor_type = latest.sensor_type AND l.timestamp = latest.max_ts ORDER BY l.unit_id, l.sensor_type;`;
    db.all(sql, [], (err, rows) => {
        if (err) { console.error("Erro G1:", err.message); res.status(500).json({ error: err.message }); return; }
        const formattedData = {};
        rows.forEach(row => {
            if (!formattedData[row.unit_id]) formattedData[row.unit_id] = {};
            let formattedValue = row.value;
            if (row.sensor_type === 'ph') formattedValue = parseFloat(row.value.toFixed(1));
            else if (['temperature', 'humidity', 'lighting'].includes(row.sensor_type)) formattedValue = parseFloat(row.value.toFixed(1));
            else if (row.sensor_type === 'co2') formattedValue = parseFloat(row.value.toFixed(0));
            formattedData[row.unit_id][row.sensor_type] = formattedValue;
        });
        res.json(formattedData);
    });
});

// GET /api/units/:id/readings (Histórico para Gráficos)
app.get('/api/units/:id/readings', (req, res) => {
    const unitId = req.params.id;
    const sensorType = req.query.sensor;
    const limit = parseInt(req.query.limit, 10) || MAX_HISTORY_PER_SENSOR;
    if (!sensorType) return res.status(400).json({ error: "Parâmetro 'sensor' é obrigatório." });
    const validSensors = ['humidity', 'temperature', 'lighting', 'co2', 'ph'];
    if (!validSensors.includes(sensorType)) return res.status(400).json({ error: "Tipo de sensor inválido." });

    const sql = `SELECT value, timestamp FROM leituras WHERE unit_id = ? AND sensor_type = ? ORDER BY timestamp DESC LIMIT ?`;
    db.all(sql, [unitId, sensorType, limit], (err, rows) => {
        if (err) { console.error(`Erro G2 (${sensorType}) U${unitId}:`, err.message); res.status(500).json({ error: err.message }); return; }
        res.json(rows.reverse()); // Envia em ordem cronológica
    });
});

// --- ROTAS DE ALERTAS (Atualizadas) ---

// POST /api/alerts (Criação)
app.post('/api/alerts', (req, res) => {
     const { name, device, condition, limit, action } = req.body;
     if (!name || !device || !condition || (limit === undefined && !['on', 'off'].includes(condition))) { return res.status(400).json({ error: "Dados incompletos." }); }
     const limitValue = (limit !== undefined && limit !== null && limit !== '') ? parseFloat(limit) : null;
     if (limitValue === null && !['on', 'off'].includes(condition)) { return res.status(400).json({ error: "Valor limite necessário."}); }
     const actionJson = action ? JSON.stringify(action) : null;
     // Assume is_active = 1 (ativo) por padrão na criação
     const sql = `INSERT INTO alertas (name, device, condition, limit_value, action, is_active) VALUES (?, ?, ?, ?, ?, 1)`;
     db.run(sql, [name, device, condition, limitValue, actionJson], function(err) {
         if (err) { console.error("Erro C3:", err.message); res.status(500).json({ error: err.message }); return; }
         res.status(201).json({ message: "Alerta criado!", id: this.lastID });
     });
});

// GET /api/alerts - Lista regras (inclui is_active)
app.get('/api/alerts', (req, res) => {
    const sql = "SELECT id, name, device, condition, limit_value, is_active FROM alertas ORDER BY name ASC";
    db.all(sql, [], (err, rows) => {
        if (err) { console.error("Erro G3:", err.message); res.status(500).json({ error: err.message }); return; }
        res.json(rows);
    });
});

// DELETE /api/alerts/:id (Deleção)
app.delete('/api/alerts/:id', (req, res) => {
    const alertId = req.params.id;
    const sql = "DELETE FROM alertas WHERE id = ?";
    db.run(sql, [alertId], function(err) {
        if (err) { console.error("Erro D3:", err.message); res.status(500).json({ error: err.message }); return; }
        if (this.changes === 0) { return res.status(404).json({ error: `Alerta ${alertId} não encontrado.` }); }
        res.json({ message: `Alerta ${alertId} deletado!`, changes: this.changes });
    });
});

// PUT /api/alerts/:id/toggle - Ativa/Desativa um alerta (PLACEHOLDER - apenas simula)
// No futuro, isso deveria realmente atualizar o banco.
app.put('/api/alerts/:id/toggle', (req, res) => {
    const alertId = req.params.id;
    const { currentState } = req.body; // Recebe o estado atual (true/false) do frontend
    const newState = !currentState; // Inverte o estado

    console.log(`[Placeholder] Alerta ${alertId} solicitado para mudar estado para: ${newState ? 'ATIVO' : 'INATIVO'}`);

    // !! IMPORTANTE: A lógica real de update no banco de dados NÃO está implementada !!
    // No código real, você faria:
    // const sql = `UPDATE alertas SET is_active = ? WHERE id = ?`;
    // db.run(sql, [newState ? 1 : 0, alertId], function(err) { ... });

    // Apenas retorna sucesso simulado para o frontend poder atualizar a UI
    res.json({ message: `Estado do Alerta ${alertId} alterado (simulado)!`, newState: newState });
});


// GET /api/alerts/history - Busca histórico de alertas disparados (PLACEHOLDER)
app.get('/api/alerts/history', (req, res) => {
    console.log("[Placeholder] Buscando histórico de alertas...");
    // !! IMPORTANTE: A lógica real de busca na tabela 'alert_history' NÃO está implementada !!
    // No código real, você faria:
    // const sql = `SELECT ah.*, a.name as alert_name FROM alert_history ah JOIN alertas a ON ah.alert_id = a.id ORDER BY ah.timestamp DESC LIMIT 50`; // Exemplo
    // db.all(sql, [], (err, rows) => { ... res.json(rows); });

    // Retorna dados dummy por enquanto
    const dummyHistory = [
        { id: 1, alert_id: 1, alert_name: "Temp Alta Unid 2", unit_id: 2, triggered_value: 28.5, timestamp: new Date(Date.now() - 60000 * 5).toISOString() },
        { id: 2, alert_id: 2, alert_name: "pH Baixo Unid 1", unit_id: 1, triggered_value: 5.4, timestamp: new Date(Date.now() - 60000 * 10).toISOString() },
        { id: 3, alert_id: 1, alert_name: "Temp Alta Unid 2", unit_id: 2, triggered_value: 28.1, timestamp: new Date(Date.now() - 60000 * 15).toISOString() },
    ];
    res.json(dummyHistory);
});


// --- FIM DAS ROTAS ---

app.listen(PORT, () => {
    console.log(`Servidor backend rodando em http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    clearInterval(simulationIntervalId);
    db.close((err) => {
        if (err) console.error('Erro ao fechar DB', err.message);
        else console.log('Conexão DB fechada.');
        process.exit(0);
    });
});