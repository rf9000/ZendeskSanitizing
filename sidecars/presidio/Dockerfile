ARG PRESIDIO_ANALYZER_DIGEST
FROM mcr.microsoft.com/presidio-analyzer@${PRESIDIO_ANALYZER_DIGEST}
ARG SPACY_MODEL_VERSION
RUN pip install --no-cache-dir \
    "https://github.com/explosion/spacy-models/releases/download/da_core_news_lg-${SPACY_MODEL_VERSION}/da_core_news_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-${SPACY_MODEL_VERSION}/en_core_web_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/de_core_news_lg-${SPACY_MODEL_VERSION}/de_core_news_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl"
COPY nlp.yml recognizers.yml analyzer.yml /app/conf/
ENV NLP_CONF_FILE=/app/conf/nlp.yml \
    RECOGNIZER_REGISTRY_CONF_FILE=/app/conf/recognizers.yml \
    ANALYZER_CONF_FILE=/app/conf/analyzer.yml
