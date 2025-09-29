/**
 * FaceCaptureApp: Gerencia a captura de vídeo, processamento de imagem,
 * comunicação com a API de análise e exibição de resultados.
 */
import Groq from "groq-sdk";

class FaceCaptureApp {
    constructor() {
        // --- Referências ao DOM (Encapsulamento) ---
        this.dom = {
            video: document.getElementById('video'),
            canvas: document.getElementById('canvas'),
            consentScreen: document.getElementById('consentScreen'),
            mainApp: document.getElementById('mainApp'),
            loading: document.getElementById('loading'),
            captureBtn: document.getElementById('captureBtn')
        };
        
        // Verifica se os elementos cruciais existem
        if (!this.dom.video || !this.dom.canvas) {
            console.error("Elementos DOM 'video' e 'canvas' são obrigatórios.");
            return; // Interrompe a inicialização
        }
        
        this.ctx = this.dom.canvas.getContext('2d');
        
        // --- Estado da Aplicação ---
        this.currentStream = null;
        this.facingMode = 'user'; // 'user' (frontal) ou 'environment' (traseira)
        this.apiUrl = null; // URL da API de análise
        
        // Dimensões do recorte elíptico (tamanho final da imagem no canvas)
        this.ellipseWidth = 307;
        this.ellipseHeight = 407;
        
        // --- Inicialização ---
        this.init();
    }

    /**
     * Inicia o fluxo de trabalho da aplicação.
     */
    async init() {
        this.initEventListeners();
        this.registerServiceWorker();
        // A detecção da API não precisa bloquear o restante
        this.detectApiUrl(); 
    }

    // ------------------------------------------
    // --- Métodos de Inicialização e Configuração ---
    // ------------------------------------------

    initEventListeners() {
        document.getElementById('acceptConsent')?.addEventListener('click', () => this.handleConsentAccept());
        document.getElementById('switchCamera')?.addEventListener('click', () => this.switchCamera());
        this.dom.captureBtn?.addEventListener('click', () => this.capturePhoto());
    }

    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('sw.js');
                console.log('Service worker registrado com sucesso.');
            } catch (error) {
                console.error('Falha no registro do Service worker:', error);
            }
        }
    }

    /**
     * Detecta a URL da API no mesmo domínio (servidor híbrido).
     */
    async detectApiUrl() {
        const currentUrl = window.location.origin;
        const healthCheckUrl = `${currentUrl}/api/health`;
        
        try {
            const response = await fetch(healthCheckUrl, { 
                method: 'GET',
                // Header para evitar o aviso do ngrok, se aplicável
                headers: {
                    'ngrok-skip-browser-warning': 'true' 
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.status === 'online') {
                    this.apiUrl = currentUrl;
                    console.log(`✅ API híbrida detectada: ${currentUrl}`);
                    this.showApiStatus(true, currentUrl);
                    return;
                }
            }
        } catch (error) {
            console.error(`❌ Erro ao conectar ou API offline: ${error}`);
        }
        
        this.showApiStatus(false);
        console.error('API híbrida não encontrada ou não respondeu corretamente.');
    }

    /**
     * Exibe o status de conexão da API no canto da tela.
     * @param {boolean} connected - Status da conexão.
     * @param {string} [url=''] - URL da API, se conectada.
     */
    showApiStatus(connected, url = '') {
        let statusEl = document.getElementById('apiStatus');
        
        if (!statusEl) {
            // Cria e anexa o elemento se ele não existir
            statusEl = this.createApiStatusElement();
        }

        if (connected) {
            statusEl.innerHTML = `<span style="color: #4CAF50;">✅ API Conectada: ${url}</span>`;
        } else {
            statusEl.innerHTML = `<span style="color: #f44336;">❌ API Não Encontrada</span>`;
        }
    }

    /**
     * Cria o elemento DOM para exibir o status da API.
     * @returns {HTMLElement} O elemento de status criado.
     */
    createApiStatusElement() {
        const status = document.createElement('div');
        status.id = 'apiStatus';
        status.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            z-index: 1000;
        `;
        document.body.appendChild(status);
        return status;
    }

    // ------------------------------------------
    // --- Métodos de Câmera ---
    // ------------------------------------------

    async handleConsentAccept() {
        this.dom.consentScreen?.classList.add('hidden');
        this.dom.mainApp?.classList.remove('hidden');
        await this.initCamera();
    }

    async initCamera() {
        if (this.currentStream) {
            // Para trilhas existentes antes de iniciar uma nova
            this.currentStream.getTracks().forEach(track => track.stop());
            this.currentStream = null;
        }

        const constraints = {
            video: { 
                facingMode: this.facingMode, 
                width: { ideal: 1280 }, 
                height: { ideal: 720 } 
            }
        };

        try {
            this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.dom.video.srcObject = this.currentStream;

            // Espera o carregamento dos metadados do vídeo para configurar o canvas
            this.dom.video.onloadedmetadata = () => this.setupCanvas();
        } catch (error) {
            alert('Erro ao acessar a câmera. Verifique as permissões.');
            console.error('Erro de câmera:', error);
        }
    }

    /**
     * Configura as dimensões do canvas.
     * Nota: O canvas de captura será redimensionado em `capturePhoto` para o tamanho final.
     */
    setupCanvas() {
        // Estes são apenas valores iniciais/de exibição, o recorte final acontece no `capturePhoto`
        this.dom.canvas.width = 800;
        this.dom.canvas.height = 1000;
    }

    async switchCamera() {
        this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
        await this.initCamera();
    }

    // ------------------------------------------
    // --- Métodos de Captura e Processamento ---
    // ------------------------------------------

    /**
     * Captura o frame do vídeo, recorta no formato elíptico e envia para a API.
     */
    async capturePhoto() {
        if (!this.dom.video.videoWidth || !this.dom.video.videoHeight) {
            alert('Câmera não está pronta. Aguarde um momento.');
            return;
        }
        
        // Desabilita o botão para evitar cliques duplicados
        this.dom.captureBtn.disabled = true;
        this.showLoading(true, 'Capturando e recortando foto...');

        try {
            // 1. Cálculo de proporção para centralizar o vídeo
            const videoRect = this.dom.video.getBoundingClientRect();
            const videoAspect = this.dom.video.videoWidth / this.dom.video.videoHeight;
            const containerAspect = videoRect.width / videoRect.height;

            let drawWidth, drawHeight, offsetX, offsetY;
            
            // Lógica para cobrir (cover) a área de visualização
            if (videoAspect > containerAspect) {
                drawHeight = this.dom.video.videoHeight;
                drawWidth = drawHeight * containerAspect;
                offsetX = (this.dom.video.videoWidth - drawWidth) / 2;
                offsetY = 0;
            } else {
                drawWidth = this.dom.video.videoWidth;
                drawHeight = drawWidth / containerAspect;
                offsetX = 0;
                offsetY = (this.dom.video.videoHeight - drawHeight) / 2;
            }

            // A escala é importante se o vídeo for renderizado em uma caixa de tamanho diferente
            const scaleX = drawWidth / videoRect.width;
            const scaleY = drawHeight / videoRect.height;

            // 2. Cálculo das dimensões do recorte elíptico
            // O centro da elipse no frame do vídeo (recortado)
            const ellipseCenterX = drawWidth / 2;
            const ellipseCenterY = drawHeight / 2;
            // O raio da elipse no frame do vídeo (aplicando a escala)
            const ellipseRadiusX = (this.ellipseWidth / 2) * (videoRect.width / videoRect.width) * scaleX; 
            const ellipseRadiusY = (this.ellipseHeight / 2) * (videoRect.height / videoRect.height) * scaleY;
            
            // 3. Configuração do Canvas de Saída
            this.dom.canvas.width = this.ellipseWidth;
            this.dom.canvas.height = this.ellipseHeight;

            // 4. Desenho e Recorte
            this.ctx.save();
            
            // Aplica a máscara elíptica
            this.ctx.beginPath();
            this.ctx.ellipse(
                this.ellipseWidth / 2, // Centro X no canvas final
                this.ellipseHeight / 2, // Centro Y no canvas final
                this.ellipseWidth / 2, // Raio X no canvas final
                this.ellipseHeight / 2, // Raio Y no canvas final
                0, 0, 2 * Math.PI
            );
            this.ctx.clip(); // Tudo o que for desenhado a seguir será limitado à elipse
            this.ctx.clearRect(0, 0, this.dom.canvas.width, this.dom.canvas.height);

            // Desenha a imagem do vídeo dentro da elipse (eixo X, Y, W, H no vídeo -> 0, 0, W, H no canvas)
            this.ctx.drawImage(
                this.dom.video,
                // Fonte (Recorte da área central do vídeo que corresponde à elipse)
                offsetX + ellipseCenterX - ellipseRadiusX, // Ponto X de início do recorte no vídeo
                offsetY + ellipseCenterY - ellipseRadiusY, // Ponto Y de início do recorte no vídeo
                ellipseRadiusX * 2, // Largura do recorte no vídeo
                ellipseRadiusY * 2, // Altura do recorte no vídeo
                // Destino (Desenhar no canvas)
                0, 0,
                this.ellipseWidth,
                this.ellipseHeight
            );

            this.ctx.restore(); // Remove a máscara de clipping

            // 5. Converter para blob e enviar
            this.dom.canvas.toBlob(async (blob) => {
                await this.analyzePhoto(blob);
            }, 'image/png', 0.95); // Usar PNG para manter qualidade, ou JPEG com alta qualidade (0.95)

        } catch (error) {
            console.error('Erro de captura:', error);
            alert('Erro ao capturar foto. Tente novamente.');
            this.showLoading(false);
            this.dom.captureBtn.disabled = false;
        }
    }

    /**
     * Envia o Blob da imagem para a API de análise.
     * @param {Blob} blob - O blob da imagem capturada.
     */
    async analyzePhoto(blob) {
        if (!this.apiUrl) {
            this.showLoading(false);
            this.dom.captureBtn.disabled = false;
            alert('API de análise não está disponível. Verifique a conexão.');
            return;
        }

        this.showLoading(true, 'Analisando foto na API...');

        try {
            const formData = new FormData();
            formData.append('file', blob, 'face-capture.png');

            const response = await fetch(`${this.apiUrl}/upload`, {
                method: 'POST',
                body: formData,
                headers: {
                    'ngrok-skip-browser-warning': 'true' // Para ngrok, se aplicável
                }
            });

            if (!response.ok) {
                // Tenta ler o erro do corpo da resposta, se possível
                let errorDetails = await response.text();
                try {
                    const json = JSON.parse(errorDetails);
                    errorDetails = json.erro || JSON.stringify(json);
                } catch {}

                throw new Error(`Falha na comunicação com a API (HTTP ${response.status}): ${errorDetails}`);
            }

            const result = await response.json();
            
            if (result.erro) {
                throw new Error(result.erro);
            }

            // Sucesso
            await this.showAnalysisResults(blob, result);
            
        } catch (error) {
            console.error('Erro de análise:', error);
            alert(`Erro na análise: ${error.message}`);
            // Fallback: mostrar preview simples se análise falhar
            await this.showPreview(blob);
        } finally {
            this.showLoading(false);
            this.dom.captureBtn.disabled = false;
        }
    }

    // ------------------------------------------
    // --- Métodos de UI e Resultados ---
    // ------------------------------------------

    /**
     * Exibe a tela de carregamento.
     * @param {boolean} show - Se deve mostrar ou esconder.
     * @param {string} [message='Processando...'] - Mensagem de carregamento.
     */
    showLoading(show, message = 'Processando...') {
        if (!this.dom.loading) return;

        const loadingText = this.dom.loading.querySelector('span') || this.dom.loading;
        
        if (show) {
            loadingText.textContent = message;
            this.dom.loading.classList.remove('hidden');
        } else {
            this.dom.loading.classList.add('hidden');
        }
    }
    
    /**
     * Exibe os resultados detalhados da análise.
     * @param {Blob} blob - O blob da imagem original.
     * @param {Object} analysisData - Dados de análise retornados pela API.
     */
    async showAnalysisResults(blob, analysisData) {
        let url = null;
        try {
            url = URL.createObjectURL(blob);
            const container = document.getElementById('analysisContainer') || this.createAnalysisContainer();
            
            // Limpar container anterior e mostrar
            container.innerHTML = '';
            container.classList.remove('hidden');

            // Preparar a interface (Template Literal mais limpo)
            const content = document.createElement('div');
            content.className = 'analysis-content';
            
            // Arredonda a confiança
            const confidence = Math.round((analysisData.face_detectada?.confianca || 0) * 100);

            content.innerHTML = `
                <div class="analysis-header">
                    <h2>Análise Facial Completa</h2>
                    <button class="close-btn" id="closeAnalysis" aria-label="Fechar Análise">×</button>
                </div>
                
                <div class="analysis-body">
                    <div class="image-section">
                        <img src="${url}" alt="Foto analisada" class="analyzed-image">
                    </div>
                    
                    <div class="results-section">
                        ${this._createResultCard('Classificação Fitzpatrick', analysisData.fitzpatrick || 'Não detectado', 'Baseado na tonalidade da pele', 'fitzpatrick')}
                        ${this._createResultCard('Tipo de Pele (Textura)', analysisData.textura || 'Não detectado', 'Análise da textura superficial', 'textura')}
                        ${this._createResultCard('Manchas', analysisData.manchas || 'Não detectado', `${analysisData.detalhes?.manchas?.numero || 0} manchas detectadas`, 'manchas')}
                        ${this._createResultCard('Linhas de Expressão', analysisData.rugas || 'Não detectado', 'Análise de rugas e linhas', 'rugas')}
                        
                        <div class="confidence-section">
                            <h3>Detecção Facial</h3>
                            <div class="confidence-bar">
                                <div class="confidence-fill" style="width: ${confidence}%"></div>
                            </div>
                            <small>Confiança: ${confidence}% (${analysisData.face_detectada?.metodo || 'N/A'})</small>
                        </div>
                    </div>
                </div>
                
                <div class="analysis-actions">
                    <button class="btn" id="downloadResults">Baixar Imagem</button>
                    <button class="btn" id="saveResults">Salvar Análise (TXT)</button>
                    <button class="btn retry-btn" id="retryCapture">Nova Foto</button>
                </div>
            `;

            container.appendChild(content);

            // Adiciona event listeners aos botões
            document.getElementById('closeAnalysis').onclick = () => this._hideAnalysisContainer(container, url);
            document.getElementById('downloadResults').onclick = () => this._downloadImage(url);
            document.getElementById('saveResults').onclick = () => this.saveAnalysisData(analysisData);
            document.getElementById('retryCapture').onclick = () => this._hideAnalysisContainer(container, url); // Reutiliza a função de fechar

        } catch (error) {
            console.error('Erro ao mostrar resultados:', error);
            // Fallback: mostrar preview simples
            if (url) URL.revokeObjectURL(url);
            await this.showPreview(blob);
        }
    }
    
    /**
     * Função auxiliar para criar um cartão de resultado HTML.
     */
    _createResultCard(title, value, detail, className) {
        return `
            <div class="result-card result-card--${className}">
                <h3>${title}</h3>
                <p class="result-value">${value}</p>
                <small>${detail}</small>
            </div>
        `;
    }

    /**
     * Esconde o container de análise e revoga a URL do objeto.
     * @param {HTMLElement} container - O container de análise.
     * @param {string} url - A URL do objeto a ser revogada.
     */
    _hideAnalysisContainer(container, url) {
        container.classList.add('hidden');
        if (url) URL.revokeObjectURL(url);
    }

    /**
     * Inicia o download da imagem capturada.
     * @param {string} url - A URL do objeto da imagem.
     */
    _downloadImage(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `analise-facial-${Date.now()}.png`;
        a.click();
    }
    
    /**
     * Salva os dados de análise em um arquivo TXT.
     * @param {Object} data - Dados de análise.
     */
    saveAnalysisData(data) {
        // Formatação mais limpa
        const formatDecimal = (value) => (value || 0).toFixed(2);
        
        const analysisText = `
ANÁLISE FACIAL - ${new Date().toLocaleString()}
=============================================

Classificação Fitzpatrick: ${data.fitzpatrick || 'Não detectado'}
Tipo de Pele: ${data.textura || 'Não detectado'}  
Manchas: ${data.manchas || 'Não detectado'}
Rugas/Linhas: ${data.rugas || 'Não detectado'}

Detalhes Técnicos:
- Confiança da Detecção: ${Math.round((data.face_detectada?.confianca || 0) * 100)}%
- Método: ${data.face_detectada?.metodo || 'N/A'}
- Número de Manchas: ${data.detalhes?.manchas?.numero || 0}
- Porcentagem de Manchas: ${formatDecimal(data.detalhes?.manchas?.porcentagem)}%
- Contraste: ${formatDecimal(data.detalhes?.textura?.contraste)}
- Homogeneidade: ${formatDecimal(data.detalhes?.textura?.homogeneidade)}
- Porcentagem de Rugas: ${formatDecimal(data.detalhes?.rugas?.porcentagem)}%

=============================================
        `.trim();

        const blob = new Blob([analysisText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `analise-facial-${Date.now()}.txt`;
        a.click();
        
        URL.revokeObjectURL(url);

        alert('Análise salva com sucesso como arquivo TXT!');
    }

    /**
     * Exibe uma pré-visualização simples da imagem capturada (usado como fallback).
     * @param {Blob} blob - O blob da imagem capturada.
     */
    async showPreview(blob) {
        const previewContainer = document.getElementById('previewContainer');
        const previewImage = document.getElementById('previewImage');

        if (!previewContainer || !previewImage) {
            console.error('Elementos de pré-visualização não encontrados.');
            return;
        }

        let url = null;
        try {
            url = URL.createObjectURL(blob);
            previewImage.src = url;
            previewContainer.classList.remove('hidden');

            document.getElementById('downloadBtn').onclick = () => {
                const a = document.createElement('a');
                a.href = url;
                a.download = `face-capture-${Date.now()}.png`;
                a.click();
            };

            document.getElementById('retryBtn').onclick = () => {
                previewContainer.classList.add('hidden');
                URL.revokeObjectURL(url);
            };

        } catch (error) {
            console.error('Erro ao gerar pré-visualização:', error);
            alert('Erro ao gerar pré-visualização.');
            if (url) URL.revokeObjectURL(url);
        }
    }

    /**
     * Cria e anexa o container de resultados da análise (incluindo estilos CSS).
     * @returns {HTMLElement} O elemento container criado.
     */
    createAnalysisContainer() {
        const container = document.createElement('div');
        container.id = 'analysisContainer';
        container.className = 'analysis-container hidden';
        
        // Adiciona estilos CSS - Melhor seria ter isso em um arquivo .css
        if (!document.getElementById('analysisStyles')) {
            const styles = document.createElement('style');
            styles.id = 'analysisStyles';
            styles.textContent = this._getAnalysisContainerStyles();
            document.head.appendChild(styles);
        }
        
        document.body.appendChild(container);
        return container;
    }

    /**
     * Retorna o CSS para o container de análise.
     */
    _getAnalysisContainerStyles() {
        return `
            .analysis-container {
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.95); display: flex; align-items: center;
                justify-content: center; z-index: 2000; overflow-y: auto;
            }
            .analysis-content {
                background: #1a1a1a; border-radius: 16px; max-width: 90vw;
                max-height: 90vh; overflow-y: auto; color: white;
            }
            .analysis-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 20px; border-bottom: 1px solid #333;
            }
            .close-btn {
                background: none; border: none; color: #fff; font-size: 24px;
                cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
            }
            .close-btn:hover { background: rgba(255, 255, 255, 0.1); }
            .analysis-body {
                display: grid; grid-template-columns: 1fr 2fr; gap: 20px; padding: 20px;
            }
            @media (max-width: 768px) {
                .analysis-body { grid-template-columns: 1fr; }
            }
            .analyzed-image {
                width: 100%; max-width: 300px; border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }
            .result-card {
                background: rgba(255, 255, 255, 0.05); padding: 16px;
                border-radius: 12px; margin-bottom: 12px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .result-card h3 { margin: 0 0 8px 0; font-size: 14px; color: #2196F3; }
            .result-value { margin: 0 0 4px 0; font-size: 18px; font-weight: bold; }
            .result-card small { color: #aaa; font-size: 12px; }
            .confidence-section {
                background: rgba(76, 175, 80, 0.1); padding: 16px;
                border-radius: 12px; border: 1px solid rgba(76, 175, 80, 0.2);
            }
            .confidence-bar {
                width: 100%; height: 8px; background: rgba(255, 255, 255, 0.1);
                border-radius: 4px; overflow: hidden; margin: 8px 0;
            }
            .confidence-fill {
                height: 100%; background: linear-gradient(90deg, #4CAF50, #2196F3);
                transition: width 0.3s ease;
            }
            .analysis-actions {
                display: flex; gap: 12px; padding: 20px; border-top: 1px solid #333;
                flex-wrap: wrap; justify-content: center;
            }
            .btn { /* Assumindo um estilo base para botões */ }
            .retry-btn { background: #ff9800 !important; }
            .retry-btn:hover { background: #f57c00 !important; }
        `;
    }
}

// Inicia a aplicação após o carregamento completo do DOM
document.addEventListener('DOMContentLoaded', () => {
    new FaceCaptureApp();
});

if ("serviceWorker" in navigator) {
  // Register a service worker hosted at the root of the
  // site using the default scope.
  navigator.serviceWorker.register("/sw.js").then(
    (registration) => {
      console.log("Service worker registration succeeded:", registration);
    },
    (error) => {
      console.error(`Service worker registration failed: ${error}`);
    },
  );
} else {
  console.error("Service workers are not supported.");
}