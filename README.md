# Gestor de Modelos de Acuerdo — Ayuntamiento

Aplicación web multiusuario para crear, editar y exportar modelos de acuerdos municipales con campos dinámicos `{{CAMPO}}` para sustitución por macro.

## Arquitectura

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Navegador     │────▶│  Nginx (frontend) │────▶│  Node.js API │
│                 │     │  Puerto 8080      │     │  Puerto 3001 │
└─────────────────┘     └──────────────────┘     └──────┬───────┘
                                                         │
                                                  ┌──────▼───────┐
                                                  │  SQLite       │
                                                  │  /data/       │
                                                  └──────────────┘
```

- **Frontend**: HTML/JS estático servido por Nginx
- **Backend**: Node.js + Express + SQLite (mejor-sqlite3)
- **Datos**: Volumen Docker persistente en `/data/acuerdos.db`

## Despliegue rápido

### 1. Requisitos
- Docker ≥ 24
- Docker Compose ≥ 2.x

### 2. Configurar entorno
```bash
cp .env.example .env
# Edita .env y cambia JWT_SECRET por una cadena aleatoria:
# openssl rand -hex 32
```

### 3. Construir e iniciar
```bash
docker compose up -d --build
```

La aplicación estará disponible en: **http://localhost:8080**

### 4. Ver logs
```bash
docker compose logs -f
docker compose logs backend
```

### 5. Parar
```bash
docker compose down
```

## Usuarios iniciales

| Email | Contraseña | Rol |
|-------|------------|-----|
| admin@ayuntamiento.es | admin123 | Administrador |
| carlos@ayuntamiento.es | editor123 | Editor |
| maria@ayuntamiento.es | editor123 | Editor |
| pedro@ayuntamiento.es | consultor123 | Consultor |

> **Cambia las contraseñas** desde la pestaña Usuarios tras el primer acceso.

## Roles

| Rol | Crear | Editar | Eliminar | Exportar | Gestionar usuarios |
|-----|-------|--------|----------|----------|--------------------|
| Administrador | ✓ | ✓ | ✓ | ✓ | ✓ |
| Editor | ✓ | ✓ | ✗ | ✓ | ✗ |
| Consultor | ✗ | ✗ | ✗ | ✓ | ✗ |

## Campos dinámicos

Los campos se insertan en el cuerpo del acuerdo con la sintaxis `{{NOMBRE_CAMPO}}`.

Al exportar a `.docx`, los campos aparecen resaltados en amarillo para su sustitución posterior con una macro de Word/LibreOffice.

### Macro Word (VBA)
```vba
Sub SustituirCampos()
    Dim campos As Variant
    campos = Array("MUNICIPIO", "ALCALDE_NOMBRE", "FECHA_SESION", "IMPORTE")
    Dim valores As Variant
    valores = Array("Mi Municipio", "Juan García López", "15/04/2026", "125.000")
    
    Dim i As Integer
    For i = 0 To UBound(campos)
        Selection.Find.Execute FindText:="{{" & campos(i) & "}}", _
            ReplaceWith:=valores(i), Replace:=wdReplaceAll
    Next i
End Sub
```

## Persistencia de datos

Los datos se guardan en un volumen Docker llamado `acuerdos-data`.

```bash
# Ver volumen
docker volume inspect acuerdos-data

# Hacer backup
docker run --rm -v acuerdos-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/backup-acuerdos-$(date +%Y%m%d).tar.gz /data

# Restaurar backup
docker run --rm -v acuerdos-data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/backup-acuerdos-YYYYMMDD.tar.gz -C /
```

## Despliegue en producción

### Con dominio propio (Nginx externo)
```nginx
server {
    listen 443 ssl;
    server_name acuerdos.miayuntamiento.es;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Variables de entorno en producción
```bash
APP_PORT=8080
JWT_SECRET=$(openssl rand -hex 32)
```

## Actualizar la aplicación

```bash
git pull
docker compose down
docker compose up -d --build
```
