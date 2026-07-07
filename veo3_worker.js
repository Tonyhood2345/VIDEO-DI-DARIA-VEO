/**
 * VEO3 WORKER — eseguito dentro GitHub Actions
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { google } = require('googleapis');

const KIE_BASE = 'https://api.kie.ai/api/v1/veo';
const KIE_API_KEY = process.env.KIE_API_KEY;
const POLL_INTERVAL_MS = 15000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; 

async function submitScene(prompt, personaggio) {
  const promptCompleto = `${prompt}\nCharacter consistency: ${personaggio.descrizione}. Keep the same character appearance, outfit, and setting consistent across the sequence.`;

  const resp = await fetch(`${KIE_BASE}/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: promptCompleto,
      imageUrls: [personaggio.fotoUrl],
      model: 'veo3_fast',
      aspect_ratio: '9:16',
      enableFallback: true,
      enableTranslation: true,
      generationType: 'REFERENCE_2_VIDEO'
    })
  });

  const json = await resp.json();
  if (json.code !== 200) {
    throw new Error(`Errore submit Veo3: ${JSON.stringify(json)}`);
  }
  return json.data.taskId;
}

async function attendiScena(taskId) {
  const scadenza = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < scadenza) {
    const resp = await fetch(`${KIE_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` }
    });
    const json = await resp.json();
    const flag = json?.data?.successFlag;

    if (flag === 1) {
      return json.data.response.resultUrls[0];
    }
    if (flag === 2 || flag === 3) {
      throw new Error(`Generazione fallita per il task ${taskId}: ${json.data.errorMessage || ''}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timeout in attesa del task ${taskId}`);
}

async function scaricaFile(url, percorso) {
  const resp = await fetch(url);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(percorso, buffer);
}

async function caricaSuDrive(percorsoFile, nomeFile) {
  const credenziali = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: credenziali,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const drive = google.drive({ version: 'v3', auth });

  const fileResp = await drive.files.create({
    requestBody: { name: nomeFile, parents: [process.env.DRIVE_FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(percorsoFile) },
    fields: 'id'
  });
  const fileId = fileResp.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

async function notificaCallback(callbackUrl, payload) {
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function main() {
  const jobId = process.env.JOB_ID;
  const callbackUrl = process.env.CALLBACK_URL;
  const personaggio = {
    nome: process.env.PERSONAGGIO_NOME,
    descrizione: process.env.PERSONAGGIO_DESCRIZIONE,
    fotoUrl: process.env.PERSONAGGIO_FOTO_URL
  };
  const scene = JSON.parse(process.env.SCENE_JSON);

  try {
    console.log('Invio le 3 scene a Veo3...');
    const taskIds = [];
    for (const s of scene) {
      taskIds.push(await submitScene(s.prompt, personaggio));
    }

    console.log('Attendo il completamento delle 3 scene...');
    const clipUrls = [];
    for (const taskId of taskIds) {
      clipUrls.push(await attendiScena(taskId));
    }

    console.log('Scarico le clip...');
    const percorsi = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const p = path.join(__dirname, `scena_${i + 1}.mp4`);
      await scaricaFile(clipUrls[i], p);
      percorsi.push(p);
    }

    console.log('Unisco le clip con ffmpeg...');
    const finale = path.join(__dirname, 'finale.mp4');
    const inputArgs = percorsi.map(p => `-i "${p}"`).join(' ');
    
    // Unione video + audio nativi
    execSync(
      `ffmpeg -y ${inputArgs} -filter_complex "concat=n=${percorsi.length}:v=1:a=1[v][a]" -map "[v]" -map "[a]" "${finale}"`,
      { stdio: 'inherit' }
    );

    console.log('Carico il video finale su Drive...');
    const downloadUrl = await caricaSuDrive(finale, `veo3_${jobId}.mp4`);

    console.log('Notifico DarIA...');
    await notificaCallback(callbackUrl, { job_id: jobId, status: 'ok', download_url: downloadUrl });

    console.log('Fatto!');
  } catch (err) {
    console.error(err);
    await notificaCallback(callbackUrl, { job_id: jobId, status: 'errore', error: String(err.message || err) });
    process.exit(1);
  }
}

main();
