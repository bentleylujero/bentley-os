FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y \
    git build-essential cmake curl \
    libvulkan-dev vulkan-tools glslc glslang-tools glslang-dev spirv-headers \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch v1.7.6 https://github.com/ggerganov/whisper.cpp.git .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=1 -DBUILD_SHARED_LIBS=ON \
    && cmake --build build --config Release -j \
    && cmake --install build --prefix /whisper-install
RUN mkdir -p /whisper-install/models && curl -L -o /whisper-install/models/ggml-small.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y \
    libgomp1 curl \
    libvulkan1 mesa-vulkan-drivers vulkan-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /whisper-install/ ./
ENV LD_LIBRARY_PATH=/app/lib:/app/bin
EXPOSE 4300
CMD ["./bin/whisper-server", "-m", "models/ggml-small.en.bin", "--host", "0.0.0.0", "--port", "4300"]
