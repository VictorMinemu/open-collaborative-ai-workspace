# PRD — Open Collaborative AI Workspace

**Versión:** 0.3  
**Estado:** Draft consolidado  
**Fecha:** 3 de septiembre de 2026  
**Tipo de producto:** Open-source collaborative AI workspace for companies

---

## 1. Resumen ejecutivo

El producto será una plataforma **open source, self-hostable, federable y multiplayer** para colaboración entre personas y agentes de IA dentro de empresas.

La plataforma combinará en una única experiencia:

- comunicación tipo Slack / Discord / Inline;
- chats directos tipo ChatGPT / Claude;
- chats de IA colaborativos entre varias personas;
- agentes de programación como Codex y Claude Code;
- sesiones de ejecución local colaborativas mediante **Work Zone**;
- agentes persistentes server-side mediante OpenClaw;
- bots personales, de proyecto, equipo, departamento y organización;
- skills compartidas, versionadas y heredables;
- MCPs compartidos con permisos;
- conocimiento y memoria con scopes empresariales;
- administración centralizada de modelos, proveedores y cuentas;
- Model Gateway con routing, pools y balanceo entre cuentas/proveedores;
- automatizaciones, scheduled tasks y agentes proactivos;
- continuidad entre Desktop, Web y Mobile;
- control remoto de sesiones locales desde móvil y web;
- proyectos y repositorios Git;
- auditoría y gobierno empresarial;
- despliegue cloud oficial o self-hosted completo.

La tesis del producto es transformar el uso empresarial de IA desde un modelo fragmentado:

```text
Cada empleado
↓
Su ChatGPT
Su Claude
Su Codex
Sus skills
Sus MCPs
Sus prompts
Sus configuraciones
```

hacia:

```text
Empresa
↓
Shared AI Infrastructure
↓
People + Agents + Projects + Knowledge + Models + Devices
```

sin eliminar la ejecución local allí donde sea necesaria.

---

# 2. Visión

## 2.1 Visión de producto

Crear:

> **The open-source multiplayer workspace for humans and AI agents.**

También puede describirse como:

> **Open-source collaborative AI operating system for companies.**

La plataforma será la capa común entre:

- empleados;
- equipos;
- proyectos;
- conversaciones;
- agentes persistentes;
- coding agents;
- modelos;
- skills;
- MCPs;
- conocimiento;
- memoria;
- permisos;
- dispositivos;
- automatizaciones.

---

# 3. Problema

Actualmente las empresas utilizan herramientas de IA de forma fragmentada:

- cada desarrollador configura individualmente Codex o Claude Code;
- cada empleado mantiene sus propios chats de IA;
- skills, prompts y MCPs se copian manualmente;
- las conversaciones de IA no son multiplayer;
- las sesiones locales de coding no pueden compartirse adecuadamente;
- Slack/Teams/Discord están separados de los agentes;
- agentes persistentes como OpenClaw viven fuera del espacio de colaboración;
- modelos y credenciales se gestionan usuario por usuario;
- el conocimiento de la empresa no se distribuye de forma gobernada;
- no existe una jerarquía empresarial común para permisos, agentes, skills y proyectos;
- el manager no dispone de una vista consolidada de uso, coste, agentes, actividad y permisos.

El producto resolverá ese problema creando una infraestructura común.

---

# 4. Objetivos

## 4.1 Objetivos principales

1. Convertir las conversaciones de IA en recursos colaborativos.
2. Convertir las sesiones locales de Codex/Claude Code en sesiones multiplayer.
3. Centralizar gobierno, skills, MCPs, modelos y permisos.
4. Permitir agentes persistentes server-side y proactivos.
5. Permitir que humanos y agentes convivan en los mismos canales.
6. Mantener ejecución local cuando el runtime lo requiera.
7. Permitir continuar/controlar tareas desde Desktop, Web o Mobile.
8. Ser completamente open source y self-hostable.
9. Facilitar una oferta cloud gestionada monetizable sin cerrar el core.
10. Diseñar el producto para empresas con estructura jerárquica real.

---

# 5. Principios de producto

## 5.1 Open source first

El producto completo deberá poder desplegarse en infraestructura propia.

Objetivo de instalación inicial:

```bash
git clone ...
docker compose up
```

Ninguna función esencial deberá depender obligatoriamente de la nube oficial.

---

## 5.2 Local when necessary, server when useful

### Ejecución local

Se utilizará cuando sea necesario acceder directamente a:

- filesystem;
- repositorios Git locales;
- terminal;
- Docker;
- aplicaciones instaladas;
- Codex;
- Claude Code;
- OpenCode;
- herramientas de escritorio;
- Word / Excel / PowerPoint en fases posteriores.

### Ejecución server-side

Se utilizará para:

- OpenClaw;
- bots persistentes;
- automatizaciones;
- scheduled tasks;
- workers gestionados;
- MCPs compartidos;
- procesos 24/7.

---

## 5.3 La sesión pertenece a la plataforma

Una regla arquitectónica clave:

> **El runtime puede ser local. La sesión no lo es.**

Una Work Zone es una entidad cloud/realtime compartida que se conecta a un runtime de ejecución local.

Esto hace posible:

- multiplayer;
- móvil;
- web;
- auditoría;
- queue;
- handoff;
- historial;
- notificaciones;
- control remoto.

---

## 5.4 Agents are first-class users

Los agentes serán participantes reales del workspace.

Ejemplo:

```text
#backend

Víctor
Alex
Guillermo
@backend
@qa
@security
```

Los agentes podrán:

- recibir menciones;
- responder;
- crear threads;
- mencionar usuarios;
- mencionar otros agentes;
- publicar artifacts;
- crear Work Zones;
- ejecutar herramientas;
- solicitar aprobaciones;
- enviar mensajes proactivos;
- ejecutar automatizaciones.

---

# 6. Usuarios y roles

## 6.1 Standard User

Puede utilizar:

- chats;
- canales;
- DMs;
- AI Chats;
- agentes autorizados;
- archivos;
- proyectos autorizados.

---

## 6.2 Developer

Además puede utilizar:

- Work Zone;
- repositories;
- Codex;
- Claude Code;
- terminal;
- diffs;
- branches;
- local MCPs;
- forks de sesiones.

---

## 6.3 Team Lead / Manager

Puede adicionalmente:

- gestionar miembros del equipo;
- compartir proyectos;
- configurar agentes del equipo;
- revisar uso y actividad;
- aprobar determinadas operaciones;
- administrar skills/MCPs según permisos.

---

## 6.4 Organization Admin

Puede administrar:

- usuarios;
- departamentos;
- equipos;
- proyectos;
- modelos;
- provider pools;
- agents;
- skills;
- MCP;
- políticas;
- devices;
- permisos;
- auditoría;
- presupuestos;
- almacenamiento;
- automatizaciones.

---

# 7. Jerarquía organizativa

La plataforma soportará:

```text
Organization
│
├── Department
│   │
│   ├── Team
│   │   ├── Project
│   │   └── Project
│   │
│   └── Team
│
└── Department
```

Ejemplo:

```text
Autofy
│
├── IT
│   ├── Backend
│   │   ├── Team Alpha
│   │   └── Team Beta
│   ├── Frontend
│   └── Infrastructure
│
└── Marketing
    ├── Performance
    └── Content
```

Cada nivel podrá tener:

- miembros;
- canales;
- proyectos;
- agentes;
- skills;
- MCPs;
- policies;
- knowledge;
- modelos permitidos;
- presupuestos.

---

# 8. Core UX Surfaces

La aplicación tendrá tres grandes modos mentales:

```text
Organization
│
├── Chats
│   ├── Channels
│   ├── Threads
│   ├── DMs
│   └── AI Chats
│
├── Work Zone
│   ├── Local coding sessions
│   ├── Generic local tasks
│   ├── Prompt queues
│   └── Collaborative execution
│
└── Agents
    ├── Personal
    ├── Project
    ├── Team
    ├── Department
    └── Organization
```

Además existirá **Projects** como capa transversal.

Navegación objetivo:

```text
Home
Chats
Work Zone
Agents
Projects
```

---

# 9. Dirección visual

## 9.1 Chats

Inspiración conceptual:

```text
Slack
+
Inline
+
Discord
+
ChatGPT
```

Características:

- sidebar organizacional;
- interfaz densa;
- pocos bordes;
- threads laterales;
- avatars;
- mentions;
- reactions;
- humanos y agentes mezclados;
- AI Chats integrados;
- alta velocidad de navegación.

---

## 9.2 Work Zone

Inspiración conceptual:

- clientes modernos de Codex;
- Claude Code GUIs;
- sesiones centradas en conversación;
- multiplayer tipo Figma/Google Docs.

No deberá convertirse en un IDE completo.

La conversación será la superficie principal.

---

# 10. Plataformas

## 10.1 Desktop

Tecnología objetivo:

**Electron + React**

Sistemas:

- macOS;
- Windows;
- Linux.

Será el cliente completo para usuarios que requieran ejecución local.

---

## 10.2 Web

Tecnología objetivo:

**Next.js + React**

Orientado a:

- administración;
- chat;
- AI Chats;
- agentes server-side;
- monitorización;
- Work Zones remotas;
- auditoría;
- configuración.

---

## 10.3 Mobile

Tecnología objetivo:

**React Native / Expo**

Plataformas:

- iOS;
- Android.

Permitirá:

- chats;
- canales;
- DMs;
- threads;
- AI Chats;
- agentes;
- monitorizar Work Zones;
- enviar prompts;
- gestionar queue;
- aprobar operaciones;
- descargar artifacts;
- recibir push notifications.

---

# 11. Chats

## 11.1 Navegación

```text
Chats

All
Mentions
Threads
AI Chats

──── Departments ────

IT
  # general
  # backend
  # infrastructure

Marketing
  # general
  # performance

──── Direct Messages ────

Alex
Guillermo
@victor-assistant
@backend
```

---

## 11.2 Channel UI

La interfaz tendrá:

```text
┌───────────────┬──────────────────────────┬────────────────────┐
│ Navigation    │ Conversation             │ Thread             │
│               │                          │                    │
│ Departments   │ #backend                 │ Selected thread    │
│ Channels      │                          │                    │
│ DMs           │ Messages                 │ Replies            │
│ Agents        │ Agent responses          │ Agent activity     │
└───────────────┴──────────────────────────┴────────────────────┘
```

El panel de thread podrá abrirse sin abandonar la conversación principal.

---

# 12. Threads

Los threads serán un concepto core.

Ejemplo:

```text
#backend

Víctor:
Tenemos que rehacer el sistema de permisos.

↳ 24 replies
```

Los agentes podrán:

- responder;
- crear threads;
- mencionar humanos;
- mencionar otros agentes;
- publicar artifacts;
- crear Work Zones.

La UI evitará jerarquías visuales infinitas.

---

# 13. Direct Messages

Existirán DMs entre:

- humano ↔ humano;
- humano ↔ agente;
- grupo de humanos;
- grupo de humanos + agentes.

Los agentes personales podrán aparecer como DMs persistentes.

---

# 14. Direct AI Chats

Los usuarios podrán crear conversaciones estilo ChatGPT.

Ejemplo:

```text
New Chat

Model:
Claude Opus

Tools:
Web
Company Knowledge
MCP
Skills
```

Una conversación tendrá:

```text
Owner: Victor
Visibility: Private
```

Y podrá compartirse posteriormente.

---

# 15. Multiplayer AI Chats — P0

Los AI Chats podrán ser compartidos entre varias personas.

Ejemplo:

```text
Architecture discussion

Participants
Víctor
Alex
@Claude
```

Conversación:

```text
Víctor:
Propón una arquitectura.

Claude:
...

Alex:
Pero necesitamos multi-tenancy.

Claude:
Teniendo en cuenta el nuevo requisito...
```

Cada mensaje conservará:

- autor;
- timestamp;
- dispositivo;
- contexto;
- permisos.

El modelo deberá conocer la identidad diferenciada de cada participante.

---

# 16. Shareable AI Conversations

Una conversación podrá evolucionar:

```text
Private AI Chat
↓
Shared with Alex
↓
Shared with Backend Team
```

Sin copiar y pegar historial.

Se conservarán:

- contexto;
- mensajes;
- attachments;
- artifacts;
- modelo;
- tools;
- permisos;
- participantes.

---

# 17. Chat → Work Zone

Una conversación podrá crear una ejecución.

Ejemplo:

```text
#backend

Alex:
Tenemos una race condition.

Víctor:
@codex arréglalo.
```

La plataforma preguntará:

```text
Project
Autofy Ecommerce

Execute on
● Victor's MacBook
○ Alex's MacBook
○ Managed Worker

[Create Work Zone]
```

Después aparecerá una card en el canal/thread.

---

# 18. Agent Cards

Las acciones complejas se representarán como cards.

Ejemplo:

```text
@backend

Created Work Zone
Authentication refactor

Host
Victor's MacBook

Runtime
Claude Code

Status
● Running

[Open] [Follow]
```

Otros tipos:

- PR creado;
- informe generado;
- aprobación solicitada;
- automatización creada;
- artifact generado;
- deployment.

---

# 19. Work Zone

## 19.1 Definición

> **A Work Zone is a collaborative cloud session attached to an execution environment.**

Work Zone no será exclusivamente para programación.

Runtimes iniciales:

- Codex;
- Claude Code;
- OpenCode;
- terminal;
- Git;
- filesystem.

Futuro:

- browser;
- Word;
- Excel;
- PowerPoint;
- otras aplicaciones locales.

---

# 20. Work Zone Architectural Principle — P0

```text
                  WORK SESSION

           ┌──────────┼──────────┐
           │          │          │
        Desktop      Web       Mobile
           │          │          │
           └──────────┼──────────┘
                      │
                Realtime Backend
                      │
              Work Session State
                      │
                  Prompt Queue
                      │
                 Device Relay
                      │
               Victor's Mac
                      │
                Local Runtime
                      │
            Codex / Claude Code
```

---

# 21. Multiplayer Work Zone — P0

Múltiples usuarios autorizados podrán:

- entrar en una sesión;
- ver actividad realtime;
- enviar prompts;
- añadir prompts a queue;
- hacer steering;
- interrumpir;
- ver estado;
- visualizar diffs;
- visualizar terminal;
- ver archivos modificados;
- recibir artifacts;
- descargar artifacts;
- solicitar archivos locales;
- aprobar acciones;
- seguir la sesión;
- usar Desktop, Web o Mobile.

---

# 22. Multi-controller / Single Executor

Modelo inicial:

> **Multiple controllers, one execution authority.**

```text
Víctor
Alex
Guillermo
Mobile
        │
        ▼
Shared Work Session
        │
        ▼
Prompt Arbiter
        │
        ▼
Victor's MacBook
        │
        ▼
Claude Code
```

No se permitirá inicialmente que múltiples agentes modifiquen el mismo working tree simultáneamente.

---

# 23. Execution Host

Cada Work Zone tendrá un host.

```text
Execution host
Victor's MacBook Pro
● Online

Runtime
Claude Code

Project
autofy-ecommerce

Branch
feature/auth
```

---

# 24. Work Zone Presence

Cabecera:

```text
[V] [A] [G] +2
```

Estados:

- Controlling;
- Viewing diff;
- Typing;
- Following;
- Away.

---

# 25. Multiplayer Prompting

Los nuevos prompts podrán ser:

## Steer

Modificar la dirección del turno actual cuando el runtime lo permita.

## Queue

Esperar al final de la ejecución actual.

## Interrupt

Cancelar/interrumpir la ejecución actual y priorizar una instrucción.

---

# 26. Prompt Queue — P0

```text
PROMPT QUEUE

RUNNING
Victor
Refactor authentication
12m 43s

NEXT
1. Alex
   Don't change the public API.

2. Guillermo
   Add integration tests.

3. Victor
   Run lint and fix warnings.
```

Permisos:

- añadir;
- editar si no ha empezado;
- eliminar;
- reordenar;
- ejecutar siguiente;
- cambiar prioridad.

---

# 27. Prompt Identity

Cada prompt conservará:

```text
prompt_id
author_user_id
origin_device_id
session_id
created_at
execution_mode
status
```

El audit log mostrará quién pidió cada acción aunque se ejecute en el dispositivo de otra persona.

---

# 28. Work Zone Permissions

Permisos posibles:

```text
VIEW
COMMENT
PROMPT
STEER
QUEUE
REORDER_QUEUE
CANCEL
APPROVE
FILES_VIEW
FILES_REQUEST
FILES_DOWNLOAD
FILES_SHARE
DIFF_VIEW
TERMINAL_VIEW
FULL_CONTROL
```

Ejemplo:

```text
Victor
Owner
Full Control

Alex
Prompt
Queue
View Files
Download Files

Guillermo
Prompt
View Diff

Nacho
View Only
```

---

# 29. Work Zone UI

Sidebar izquierdo:

```text
Work Zone

+ New Session
History
Scheduled

PROJECTS

autofy-ecommerce
  ● Authentication refactor
  ○ Stripe webhook
  ○ Product filters

histolab_erp
  ○ PDF upload
```

Centro:

- conversación;
- agent actions;
- prompts;
- approvals;
- results;
- artifacts.

Panel derecho opcional:

```text
Activity
Queue
Changes
Files
Terminal
Context
People
```

---

# 30. Work Zone Header

```text
Payments / Authentication Refactor

● Running on Victor's MacBook
Claude Code · Opus
feature/auth

[V][A][G] +2

[Share] [Queue 2] [···]
```

---

# 31. Follow Session

Un usuario podrá seguir una sesión sin controlarla.

Eventos:

- waiting for approval;
- task completed;
- task failed;
- mention;
- prompt completed;
- device disconnected.

---

# 32. Local Runtime Daemon

Electron incluirá un servicio local independiente.

```text
Desktop App
     │
     ▼
Local Runtime Daemon
```

Responsabilidades:

- lanzar Codex;
- lanzar Claude Code;
- lanzar OpenCode;
- terminal;
- filesystem;
- Git;
- Docker;
- local MCP;
- skills sync;
- secrets injection;
- remote session control;
- event streaming;
- device connection;
- project registration.

Arquitectura:

```text
Electron
    │
    ▼
Local Runtime
    │
    ├── Codex Adapter
    ├── Claude Code Adapter
    ├── OpenCode Adapter
    ├── Git Adapter
    ├── Terminal Adapter
    ├── Filesystem Adapter
    ├── MCP Runtime
    ├── Skills Manager
    ├── Project Manager
    └── Remote Session Agent
```

Objetivo futuro recomendado: Rust para el daemon.

---

# 33. Runtime Adapter API

Interfaz común conceptual:

```text
AgentRuntime
```

Implementaciones:

```text
CodexRuntime
ClaudeCodeRuntime
OpenCodeRuntime
OpenClawRuntime
GenericLLMRuntime
```

El resto del producto no debe depender de detalles internos de cada runtime.

---

# 34. Unified Session Event Protocol

Eventos normalizados:

```text
session.started
session.waiting
session.completed
session.failed

assistant.message
assistant.thinking

tool.requested
tool.started
tool.output

command.started
command.completed

file.changed
git.diff

approval.requested
approval.resolved

participant.joined
participant.left
participant.typing

prompt.created
prompt.updated
prompt.queued
prompt.reordered
prompt.cancelled

execution.steered

file.requested
file.shared
file.downloaded

artifact.created
session.followed
permission.denied
```

---

# 35. Remote Task Control

Una sesión local podrá controlarse desde otros dispositivos.

Ejemplo:

Usuario inicia en Mac:

```text
Claude Code:
Refactor the authentication service and run the tests.
```

Desde iPhone:

```text
Active Sessions

MacBook Pro
└── Authentication refactor
    ● Running
    18m 42s
```

Podrá:

- ver output;
- enviar nuevo prompt;
- queue;
- pause;
- stop;
- approve;
- ver diff;
- descargar artifacts.

---

# 36. Device Relay

Cada Local Runtime mantendrá una conexión saliente segura.

```text
MacBook
Local Runtime
     │
     ▼
Device Relay
     ▲
     │
Mobile / Web
```

No será necesario abrir puertos en el dispositivo.

El backend conocerá:

- online/offline;
- latency;
- active sessions;
- runtime versions;
- project registrations;
- pending approvals.

---

# 37. Device Management

Pantalla:

```text
My Devices

MacBook Pro
● Online
3 active sessions

Office PC
○ Offline

Home Mac Mini
● Online
0 active sessions
```

Admin podrá:

- autorizar;
- revocar;
- bloquear versiones;
- exigir actualización;
- limitar projects;
- definir políticas.

---

# 38. Mobile Application

## Mobile V1

- organizations;
- channels;
- DMs;
- threads;
- AI Chats;
- agents;
- mentions;
- notifications;
- Work Zone monitoring;
- prompts;
- queue;
- stop/pause/resume;
- approvals;
- artifacts;
- files autorizados.

---

# 39. Mobile Approvals

Ejemplo:

```text
Claude Code requires approval

Command
pnpm prisma migrate deploy

Project
Payments

Device
MacBook Pro

[Reject] [Approve]
```

Los permisos determinarán quién puede aprobar.

---

# 40. Handover entre dispositivos

Una sesión no pertenecerá a una UI.

```text
Desktop
↓
Mobile
↓
Web
↓
Desktop
```

Al volver al ordenador:

```text
Authentication Refactor
3 messages were sent from iPhone.
Resume
```

---

# 41. Projects

Un Project representa una unidad de trabajo.

Contiene:

- repositorios;
- documentación;
- canales;
- miembros;
- agentes;
- skills;
- MCPs;
- model policies;
- knowledge;
- Work Zones.

Ejemplo:

```text
Project: Ecommerce

Repositories:
autofy/backend
autofy/frontend
autofy/mobile
```

Git será la fuente principal para sincronización de código entre desarrolladores.

---

# 42. Git Integration

La plataforma mostrará:

- branch;
- base commit;
- current commit;
- uncommitted changes;
- diffs;
- PRs;
- conflicts;
- repository status.

Una sesión tendrá:

```text
Repository
Branch
Commit at session start
Current commit
Working tree state
```

---

# 43. Session Forking — Future

Un usuario podrá bifurcar una Work Zone hacia su propio dispositivo.

```text
Session #892
Host: Victor's MacBook

[Fork to my device]
```

La plataforma reconstruirá:

- repository;
- base commit;
- branch;
- diff;
- skills;
- MCPs;
- config.

Resultado:

```text
Session #892
├── Victor Execution
└── Alex Fork
```

---

# 44. Files and Artifacts

Se distinguirán tres tipos.

## 44.1 Source Files

Archivos Git del proyecto.

Identidad:

```text
repository
branch
commit
relative_path
working_tree_state
```

No se subirán automáticamente al servidor.

---

## 44.2 Local Files

Archivos existentes solamente en el host.

Ejemplo:

```text
results.csv
Local · Victor's MacBook
```

Podrán:

- previsualizarse si está permitido;
- solicitarse;
- compartirse explícitamente.

---

## 44.3 Shared Artifacts

Archivos publicados deliberadamente.

```text
migration-report.md
18 KB

[Preview] [Download]
```

---

# 45. Artifact Upload Pipeline

```text
Local File
↓
Workspace containment validation
↓
Policy validation
↓
SHA-256
↓
Security checks
↓
Encrypted upload
↓
Object Storage
↓
SessionArtifact
```

---

# 46. File Request

```text
Alex
↓
Backend
↓
Device Relay
↓
Victor Local Runtime
↓
Permission/path validation
↓
File transfer
↓
Alex
```

Modos:

- relay-only;
- persisted artifact.

---

# 47. Artifact Storage Policies

Configurable por organización:

```text
Cloud Artifact Storage
● Enabled
○ Encrypted only
○ Disabled
```

Retention:

- 7 days;
- 30 days;
- 90 days;
- custom.

Modo sensible:

```text
Server persistence: Disabled
Relay only
```

---

# 48. Absolute Path Privacy

No se expondrán rutas absolutas del host.

Permitido:

```text
src/auth/auth.service.ts
```

No permitido:

```text
/Users/victor/Projects/autofy/backend/src/auth/auth.service.ts
```

El mapping absoluto existirá solamente en Local Runtime.

---

# 49. Registered Projects on Remote Devices

Desde Web/Mobile se podrán seleccionar projects previamente registrados.

```text
My MacBook

Payments
Ecommerce
ERP
```

No se permitirá explorar arbitrariamente todo el filesystem.

---

# 50. Model Gateway

Todo runtime podrá usar un endpoint centralizado.

```text
Codex / Claude Code / AI Chat
           │
           ▼
      Model Gateway
           │
   ┌───────┼────────┐
   │       │        │
OpenAI  Anthropic  Others
```

El cliente utiliza credenciales de la plataforma, no las credenciales reales del proveedor.

---

# 51. Provider Pools

Una organización podrá crear pools.

```text
Pool: Engineering Claude

Anthropic Account 01
Anthropic Account 02
Anthropic Account 03
Anthropic Account 04
```

El router decidirá la cuenta según:

- disponibilidad;
- cuota;
- consumo;
- rate limit;
- cooldown;
- errores;
- prioridad;
- latencia;
- modelo;
- organization policy;
- workspace access.

No se limitará a round robin simple.

---

# 52. Provider Account State

Entidad conceptual:

```text
provider_account

status
quota
current_usage
rate_limit_state
last_request
recent_errors
cooldown_until
priority
weight
workspace_access
```

---

# 53. Model Routing

Políticas posibles:

```text
Simple question → cheap model
Coding → coding model
Research → high-capability model
Private data → local model
```

Fallback:

```text
Claude Opus
↓
GPT
↓
Claude Sonnet
```

---

# 54. Organization Model Governance

Admin podrá controlar:

- modelos permitidos;
- modelos bloqueados;
- providers;
- provider pools;
- budgets;
- fallbacks;
- modelos por team;
- modelos por project;
- modelos por agent.

---

# 55. Skills

Las skills serán recursos versionados.

Scopes:

- Organization;
- Department;
- Team;
- Project;
- User.

Ejemplo:

```text
Organization
└── security-policy

IT
└── development-standards

Backend
└── nestjs-guidelines

Payments Project
└── stripe-integration

Victor
└── personal-workflow
```

---

# 56. Skill Inheritance

Effective Skills:

```text
Organization skills
+
Department skills
+
Team skills
+
Project skills
+
User skills
```

Cuando un administrador actualice:

```text
nestjs-guidelines
v17 → v18
```

los dispositivos afectados deberán sincronizar automáticamente.

---

# 57. Skill Versioning

Debe soportar:

- semantic versions;
- changelog;
- rollback;
- pinning;
- mandatory versions;
- staged rollout;
- compatibility metadata.

---

# 58. GitOps for AI Configuration

Opcionalmente un workspace/project podrá exportarse a Git.

```text
agents/
  backend/
    agent.yaml
    SOUL.md
    skills/
  marketing/
    agent.yaml

skills/
policies/
workspace.yaml
permissions.yaml
```

Objetivos:

- portability;
- code review;
- versioning;
- no vendor lock-in.

---

# 59. MCP

Los MCP Servers tendrán scopes empresariales.

Ejemplo:

```text
GitHub MCP
Scope: Organization

PostHog MCP
Scope: Product Team

Supabase Production
Scope: Backend
Approval required: true
```

---

# 60. MCP Permissions

Se distinguirá:

- disponibilidad;
- capabilities;
- read/write;
- secrets;
- approvals;
- user-level access;
- agent-level access.

---

# 61. Policies

Las políticas serán independientes de las skills.

Ejemplo:

```text
Production access = prohibited
Shell destructive commands = approval required
Personal agents = enabled
Max personal agents = 3
```

Modelo conceptual:

```text
Effective permissions =
Organization
∩ Department
∩ Team
∩ Project
∩ User
∩ Agent
∩ Tool
```

Las restricciones superiores prevalecen.

---

# 62. Persistent Agents

Se utilizará principalmente OpenClaw para agentes persistentes.

Tipos:

## Personal Agent

```text
@victor-assistant
```

## Project Agent

```text
@payments-agent
```

## Team Agent

```text
@backend
```

## Department Agent

```text
@it-support
```

## Organization Agent

```text
@company
```

---

# 63. Personal Agent Policies

Admin podrá definir:

```text
Personal Agents
Enabled: Yes
Max agents/user: 3
Allowed runtimes: OpenClaw
Allowed MCPs: Gmail, Calendar, GitHub
Forbidden: Production DB, Production AWS
```

---

# 64. Agent Builder

Desktop/Web permitirán crear agentes.

Campos:

## Identity

- Name;
- Username;
- Avatar;
- Description.

## Scope

- Personal;
- Project;
- Team;
- Department;
- Organization.

## Runtime

- OpenClaw;
- future managed runtimes.

## Model

- default;
- fallback;
- provider pool.

## Skills

Selección e inheritance.

## MCP

Selección y permisos.

## Channels

Dónde puede participar.

## Permissions

Acciones permitidas.

## Triggering

- mention;
- DM;
- automatic;
- scheduled;
- event-based.

---

# 65. OpenClaw Native Channel — P0

La plataforma se expondrá como **canal nativo de OpenClaw**.

Se desarrollará un plugin conceptual:

```text
@ourplatform/openclaw-channel
```

OpenClaw no hablará directamente con la implementación interna de mensajería.

Ruta:

```text
OpenClaw
   │
   ▼
Our OpenClaw Channel Plugin
   │
   ▼
Agent Channel API
   │
   ▼
Our Backend
   │
   ├── Chat Service
   ├── Permissions
   ├── Audit
   ├── Artifacts
   └── Federation layer
```

---

# 66. OpenClaw Inbound

Debe soportar:

- channel messages;
- DMs;
- threads;
- mentions;
- replies;
- attachments;
- authorized actions.

Flujo:

```text
Victor
↓
#backend
↓
Backend realtime event
↓
OpenClaw Channel Plugin
↓
OpenClaw agent
```

---

# 67. OpenClaw Outbound

OpenClaw podrá enviar:

- text;
- replies;
- thread messages;
- DMs;
- attachments;
- artifacts;
- approval requests;
- cards/event payloads.

Flujo:

```text
OpenClaw agent
↓
message/sendMedia
↓
Channel Plugin
↓
Agent Channel API
↓
Backend
↓
Persist + Broadcast + Push + Audit
```

---

# 68. OpenClaw Proactive Messaging — P0

Los agentes podrán iniciar mensajes sin que un usuario los contacte previamente.

Ejemplos:

- informe semanal;
- alerta de incidente;
- resumen diario;
- tarea completada;
- recordatorio;
- seguimiento de ventas;
- resultado de scheduled task.

Ejemplo:

```text
@weekly-report
Every Friday 17:00
↓
collect data
↓
generate report
↓
send → #management
```

---

# 69. Standing Orders + Automations

Se distinguirá:

```text
Standing order = QUÉ debe hacer
Automation = CUÁNDO debe hacerlo
```

La UI abstraerá los detalles internos del runtime.

Ejemplo:

```text
AUTOMATION
Weekly company report

Agent
@company-analyst

When
Every Friday
17:00 Europe/Madrid

Deliver to
#management

Instructions
Generate the weekly company report.
```

---

# 70. Natural Language Automation Creation

Ejemplo:

```text
Victor:
@analyst cada viernes a las 17h haz un informe de métricas y mándalo a #management.
```

La plataforma/agente podrá crear:

```text
standing_order
schedule
timezone
delivery_target
```

Después mostrará una card de confirmación.

---

# 71. Delivery Targets

Entidad:

```text
AgentDeliveryTarget

id
organizationId
agentId
type: channel | thread | dm
conversationId
threadId?
permissions
createdBy
```

Los targets se almacenarán mediante IDs estables, no nombres.

Ejemplo:

```text
channel:uuid
thread:uuid
user:uuid
```

---

# 72. OpenClaw Bindings

Cada identidad de agente tendrá una cuenta/canal asociada.

Ejemplo:

```text
OpenClaw Gateway
│
├── agentId: backend
│   └── channel account: backend-agent
│
├── agentId: marketing
│   └── channel account: marketing-agent
│
└── agentId: victor-assistant
    └── channel account: victor-assistant
```

---

# 73. OpenClaw Approvals

Las solicitudes de aprobación deberán integrarse en el chat.

Ejemplo:

```text
@devops requires approval

Production deployment
Command: kubectl apply ...

[Reject] [Approve once]
```

La posibilidad de aprobar dependerá de policies.

---

# 74. OpenClaw Attachments

Los agentes podrán generar archivos.

Flujo:

```text
OpenClaw
↓
sendMedia
↓
Channel Plugin
↓
Artifact API
↓
Object Storage
↓
Message attachment
```

---

# 75. Agent-to-Agent Collaboration

Los agentes podrán mencionar otros agentes.

Ejemplo:

```text
Victor:
@backend implementa la feature y cuando termines pásasela a @qa.

@backend:
Implementación terminada.
@qa revisa commit 2839f2.

@qa:
He encontrado dos problemas.
```

Debe conservarse trazabilidad completa.

---

# 76. Agent-to-Agent Permissions

Controlar:

```text
Human → Agent
Agent → Agent
Agent → Tool
Agent → Channel
Agent → External Agent
```

Ejemplo:

```text
@accountant
can_message:
  - @invoice-agent
  - @bank-agent
cannot_message:
  - @production-agent
```

---

# 77. Memory

Memorias separadas:

```text
Personal Memory
Agent Memory
Project Memory
Team Memory
Channel Memory
Organization Memory
Thread Context
```

Contexto efectivo:

```text
Thread context
+
Project context
+
Team knowledge
+
Department knowledge
+
Organization knowledge
+
Agent memory
+
Allowed user memory
```

---

# 78. Memory Isolation

Una conversación privada nunca deberá convertirse automáticamente en memoria compartida.

Policies configurables:

- no persistence;
- user only;
- project;
- team;
- organization;
- explicit promotion only.

---

# 79. Knowledge

Scopes:

- organization;
- department;
- team;
- project;
- user.

Posibles fuentes:

- files;
- docs;
- repositories;
- Notion/Drive integrations;
- internal APIs;
- structured databases.

---

# 80. Team Home

Cada equipo tendrá una página.

```text
Backend Team

12 Members
4 Agents
7 Active Projects

ACTIVE WORK
● Authentication refactor — Victor + Codex
● ERP permissions — Alex + Claude
● Payment migration — Guillermo + @backend

CHANNELS
# backend
# code-review
# incidents

AGENTS
@backend
@qa
@security

PROJECTS
Ecommerce
ERP
Payments
```

---

# 81. Admin Console

## Organization

- users;
- roles;
- departments;
- teams.

## AI

- providers;
- provider accounts;
- pools;
- models;
- budgets.

## Agents

- bots;
- personal agents;
- templates;
- runtimes;
- automations.

## Development

- projects;
- repositories;
- skills;
- MCPs.

## Devices

- authorized devices;
- versions;
- online status;
- sessions.

## Security

- permissions;
- policies;
- audit;
- secrets.

---

# 82. Security Model

Principio: least privilege.

Se distinguirá entre:

```text
User permissions
Agent permissions
Channel permissions
Project permissions
Tool permissions
Device permissions
```

Una acción solamente podrá realizarse si todas las capas necesarias la permiten.

---

# 83. Secrets

Los secretos deberán almacenarse en un secret store.

Ejemplos:

- API keys;
- GitHub tokens;
- AWS credentials;
- DB credentials;
- MCP secrets;
- provider credentials.

Nunca se almacenarán directamente dentro de skills.

Tecnología objetivo posible:

- OpenBao;
- cloud KMS;
- Vault-compatible abstraction.

---

# 84. Audit Log

Toda acción sensible generará un evento.

Ejemplo:

```text
10:42 Victor prompted @backend
10:43 @backend accessed GitHub
10:44 @backend modified branch feature/auth
10:51 Alex approved command
10:53 @backend created PR #183
```

Campos:

- actor;
- agent;
- user;
- device;
- resource;
- action;
- result;
- timestamp;
- organization;
- session.

---

# 85. Realtime Requirements

Debe soportar:

- messages;
- presence;
- typing;
- streaming output;
- queue;
- execution state;
- approvals;
- file events;
- terminal events;
- diffs;
- notifications;
- agent proactive messages.

Objetivo inicial para eventos colaborativos normales:

```text
< 500 ms typical propagation
```

---

# 86. Federation

El producto será federable.

Principio:

```text
company-a.example
       │
       │ federation
       ▼
company-b.example
```

Federation permitirá:

- shared rooms;
- external users;
- external agents;
- cross-company collaboration;
- agent-to-agent interactions.

No se considera P2P puro entre dispositivos como arquitectura principal.

---

# 87. Federation Layer

Se podrá utilizar Matrix o un protocolo compatible como implementación subyacente, manteniendo nuestra API de producto por encima.

OpenClaw deberá integrarse con **nuestro channel API**, no directamente con Matrix, para no saltarse:

- permisos;
- agent identity;
- artifacts;
- audit;
- cards;
- organization hierarchy;
- policies.

---

# 88. Generic Local Tasks — Future

El Local Runtime se extenderá más allá de programación.

```text
Local Task Runtime
├── Development
├── Browser
├── Office
├── Design
└── Operating System
```

Ejemplo:

> Analiza estos documentos y actualiza el Word con las conclusiones.

Desde móvil:

- ver progreso;
- responder;
- aprobar;
- añadir instrucciones;
- detener.

---

# 89. Office Automation — Future

Integraciones potenciales:

- Microsoft Word;
- Excel;
- PowerPoint;
- Outlook;
- browser;
- filesystem.

---

# 90. Full Remote Computer Access — Future

No será parte del MVP.

Inicialmente se soportará control semántico:

```text
send prompt
approve
stop
continue
view diff
view terminal output
```

No inicialmente:

```text
stream desktop
mouse control
keyboard control
```

---

# 91. Arquitectura de alto nivel

```text
                ┌───────────────────────┐
                │      WEB APP          │
                └──────────┬────────────┘
                           │
┌───────────────┐          │          ┌───────────────┐
│ MOBILE APP    │──────────┼──────────│ DESKTOP APP   │
└───────────────┘          │          └──────┬────────┘
                           │                 │
                           ▼                 ▼
               ┌────────────────────┐   Local Runtime
               │   CONTROL PLANE    │        │
               │                    │        ├─ Codex
               │ Organizations      │        ├─ Claude Code
               │ Teams              │        ├─ OpenCode
               │ Projects           │        ├─ Git
               │ Agents             │        ├─ Terminal
               │ Skills             │        ├─ Filesystem
               │ Permissions        │        └─ MCP
               │ Sessions           │
               └────────┬───────────┘
                        │
       ┌────────────────┼────────────────┐
       │                │                │
       ▼                ▼                ▼
 Model Gateway      Chat Layer      Device Relay
       │
       ├─ OpenAI
       ├─ Anthropic
       ├─ Gemini
       └─ Others

               ┌─────────────────────┐
               │ SERVER AGENT PLANE  │
               │                     │
               │ OpenClaw            │
               │ Workers             │
               │ Automations         │
               └─────────────────────┘
```

---

# 92. Control Plane

El Control Plane será una de las piezas de mayor valor del producto.

Responsabilidades:

- organizations;
- identity;
- permissions;
- teams;
- projects;
- agents;
- skills;
- MCP;
- policies;
- models;
- providers;
- budgets;
- sessions;
- devices;
- automations;
- auditing.

---

# 93. Agent Execution Plane

OpenClaw será usado como runtime, no como backend multi-tenant principal.

Modelo:

```text
Workspace A
└── OpenClaw Cell
    ├── Agent A
    ├── Agent B
    └── Agent C

Workspace B
└── OpenClaw Cell
    ├── Agent D
    └── Agent E
```

Cada trust boundary tendrá aislamiento adecuado.

---

# 94. Stack técnico inicial

## Frontend

```text
Desktop: Electron + React
Web: Next.js + React
Mobile: Expo / React Native
```

## Backend

```text
TypeScript
NestJS or Fastify
PostgreSQL
Redis
NATS JetStream
```

## Workflows

```text
Temporal
```

## Server Agent Runtime

```text
OpenClaw
Docker
```

Posteriormente:

```text
Kubernetes
gVisor / Kata
```

## Secrets

```text
OpenBao / KMS abstraction
```

## Object Storage

```text
S3-compatible
```

## Observability

```text
OpenTelemetry
Prometheus
Grafana
Loki
```

---

# 95. Core Entities

```text
Organization
OrgUnit
User
Membership
Role

Device
DeviceSession

Project
Repository

Channel
Thread
Conversation
Message
ConversationParticipant

Agent
AgentTemplate
AgentRuntime
AgentDeliveryTarget
Automation

Skill
SkillVersion
SkillAssignment

MCPServer
MCPAssignment

Provider
ProviderAccount
ProviderPool
Model
ModelPolicy

WorkSession
WorkSessionParticipant
WorkSessionPermission

Execution
ExecutionRuntime
ExecutionDevice

Prompt
PromptQueueItem

RepositoryState
FileReference
Artifact
ArtifactPermission

SessionEvent
ApprovalRequest

SecretReference
Policy
Permission

Memory
KnowledgeSource

AuditEvent
Notification
```

---

# 96. APIs / Services

Servicios lógicos:

```text
Identity Service
Organization Service
Chat Service
Realtime Service
Work Session Service
Device Relay Service
Model Gateway
Provider Router
Agent Service
OpenClaw Channel API
Automation Service
Skills Service
MCP Service
Policy Service
Artifact Service
Audit Service
Notification Service
Federation Service
```

Podrán empezar en un modular monolith y separarse posteriormente.

---

# 97. Non-Functional Requirements

## Security

- encryption in transit;
- encryption at rest where appropriate;
- least privilege;
- tenant isolation;
- secret separation;
- signed device identity;
- auditability.

## Reliability

- reconnectable realtime sessions;
- replayable session events;
- resumable uploads;
- idempotent automation delivery;
- queue persistence.

## Scalability

Diseño inicial preparado para:

- múltiples organizations;
- miles de users;
- miles de agents;
- many concurrent Work Sessions;
- large chat history;
- horizontal scaling of gateways and relays.

---

# 98. Notifications

Canales:

- desktop;
- web;
- mobile push;
- optional email.

Eventos:

- mention;
- agent response;
- task completed;
- task failed;
- approval required;
- queue started;
- device offline;
- artifact ready;
- automation delivered;
- budget warning.

---

# 99. North Star Metric

Principal:

> **AI-assisted tasks successfully completed per active organization.**

Secundarias:

- active organizations;
- active users;
- Work Sessions started;
- Work Sessions completed;
- AI Chats;
- shared AI Chats;
- agents used;
- agents created;
- remote prompts;
- mobile approvals;
- skills distributed;
- artifacts generated;
- agent proactive messages;
- automations completed;
- model cost per completed task.

---

# 100. Open Source License Strategy

Propuesta inicial:

```text
Server / Control Plane: AGPLv3
Desktop: AGPLv3
Web: AGPLv3
Mobile: AGPLv3
Protocol / SDK: Apache 2.0
Agent SDK: Apache 2.0
Plugins: Apache 2.0
```

La marca comercial se protegerá independientemente del código.

---

# 101. Monetización

El código seguirá siendo open source.

La monetización vendrá principalmente de operación y servicios.

## Community Self-hosted

Gratis.

## Managed Cloud

Hosting gestionado.

## Agent Runtime / Compute

Cobro por:

- active agents;
- execution hours;
- worker compute;
- storage.

## Model Usage

- pass-through;
- metering;
- optional markup depending on strategy.

## Enterprise

- dedicated deployments;
- private VPC;
- SLA;
- support;
- compliance;
- backups;
- disaster recovery;
- managed upgrades;
- SSO;
- SCIM;
- private networking.

## Marketplace

Comisión por:

- agents;
- skills;
- templates;
- integrations.

---

# 102. Pricing Direction

No basarlo exclusivamente en seats.

Posible fórmula:

```text
Base workspace
+
Users
+
Agent runtime
+
Compute
+
Model usage
```

Porque:

```text
Company A
5 humans
50 agents

Company B
100 humans
2 agents
```

requieren economics diferentes.

---

# 103. Marketplace — Future

Catálogo posible:

```text
GitHub Maintainer
SEO Specialist
Recruiting Agent
Customer Support Agent
DevOps Agent
PostHog Analyst
Salesforce Agent
```

Un package podrá incluir:

- prompt/personality;
- skills;
- MCPs;
- permissions;
- workflows;
- recommended models;
- memory schema.

---

# 104. MVP Roadmap

## MVP 1 — Collaborative Workspace

P0:

- organizations;
- users;
- departments;
- teams;
- channels;
- threads;
- DMs;
- realtime;
- presence;
- direct AI Chats;
- multiplayer AI Chats;
- agents in conversations.

---

## MVP 2 — Multiplayer Work Zone

P0:

- Electron;
- Local Runtime;
- Codex;
- Claude Code;
- WorkSession server entity;
- participants;
- realtime execution events;
- prompt identity;
- prompt queue;
- steering where supported;
- permissions;
- execution host;
- Git state;
- changed files;
- basic artifacts.

---

## MVP 3 — Shared AI Infrastructure

- Model Gateway;
- provider pools;
- intelligent routing;
- account health;
- quotas;
- budgets;
- policies.

---

## MVP 4 — Organizational AI Configuration

- skills;
- inheritance;
- versioning;
- MCP;
- policies;
- device sync;
- project context.

---

## MVP 5 — Persistent Agents + OpenClaw Channel

P0:

- OpenClaw runtime;
- native platform channel plugin;
- inbound messages;
- outbound messages;
- proactive messages;
- personal agents;
- team agents;
- department agents;
- organization agents;
- agent-to-agent;
- scheduled automations;
- delivery targets;
- approvals.

---

## MVP 6 — Remote Work Zone

- Device Relay;
- Web Work Zone;
- remote prompts;
- queue control;
- remote approvals;
- file requests;
- artifacts;
- follow session.

---

## MVP 7 — Mobile

- iOS;
- Android;
- Chats;
- channels;
- DMs;
- threads;
- AI Chats;
- agent conversations;
- Work Zone monitoring;
- prompts;
- queue;
- approvals;
- artifacts;
- push.

---

# 105. Future Roadmap

- federation production-ready;
- external organizations;
- marketplace;
- agent packages;
- full remote computer control;
- Office automation;
- browser automation;
- managed cloud coding agents;
- visual workflows;
- advanced compliance;
- SSO/SCIM;
- dedicated deployments;
- edge runtimes;
- local models;
- cross-device session forks;
- collaborative prompt drafting;
- external agent federation.

---

# 106. MVP Non-Goals

No construir inicialmente:

- IDE completo;
- collaborative filesystem en tiempo real;
- múltiples agents escribiendo simultáneamente el mismo working tree;
- full desktop streaming;
- mouse/keyboard remote desktop;
- marketplace completo;
- complex office automation;
- infinite thread nesting;
- arbitrary filesystem browsing from mobile.

---

# 107. Riesgos principales

## 107.1 Runtime fragmentation

Codex, Claude Code y otros runtimes pueden producir eventos diferentes.

Mitigación:

- Runtime Adapter API;
- Unified Session Event Protocol.

## 107.2 Local device connectivity

El host puede dormir o desconectarse.

Mitigación:

- heartbeat;
- reconnect;
- persisted queue;
- clear offline state;
- optional future managed workers.

## 107.3 Permission complexity

La herencia enterprise puede volverse difícil de entender.

Mitigación:

- effective permission viewer;
- policy simulator;
- explicit deny precedence;
- templates.

## 107.4 Agent autonomy

Agentes proactivos pueden generar ruido o ejecutar acciones no deseadas.

Mitigación:

- delivery permissions;
- budget limits;
- automation visibility;
- approval policies;
- rate limits.

## 107.5 File privacy

Una Work Zone local puede exponer información sensible.

Mitigación:

- relative paths;
- registered workspaces;
- containment checks;
- explicit sharing;
- relay-only mode;
- retention controls.

---

# 108. Acceptance Criteria — Core

El producto habrá validado la tesis inicial cuando sea posible realizar de extremo a extremo:

### Scenario A — Multiplayer Coding

1. Víctor abre un project en Desktop.
2. Inicia Claude Code en Work Zone.
3. Alex entra desde otro ordenador.
4. Ambos ven output realtime.
5. Alex añade un prompt a la queue.
6. Víctor sale del ordenador.
7. Desde móvil aprueba una operación.
8. Claude termina.
9. Ambos descargan el artifact.
10. El resultado se publica en #backend.

### Scenario B — Multiplayer AI Chat

1. Víctor crea un AI Chat privado.
2. Lo comparte con Alex.
3. Ambos escriben en tiempo real.
4. El modelo distingue a ambos usuarios.
5. Desde el chat crean una Work Zone.

### Scenario C — Proactive OpenClaw Agent

1. Admin crea @weekly-report.
2. Le asigna skills y MCPs.
3. Configura una automatización semanal.
4. Delivery target = #management.
5. OpenClaw despierta el agente sin prompt humano.
6. Genera el informe.
7. Publica texto + PDF en #management.
8. La entrega queda auditada.

### Scenario D — Enterprise Governance

1. Admin actualiza una skill de Backend.
2. Todos los devices del equipo reciben la nueva versión.
3. Un usuario no autorizado intenta acceder a un MCP de producción.
4. La plataforma bloquea la acción.
5. El intento aparece en audit log.

---

# 109. Product Thesis Final

El producto no será:

- otro chat con bots;
- otro frontend de Codex;
- otro Claude Code empresarial;
- otro Discord con IA.

Será:

> **Una infraestructura colaborativa de IA para toda la organización.**

La principal diferencia será convertir experiencias tradicionalmente individuales en recursos compartidos y gobernables:

```text
AI Chat
→ multiplayer

Coding Session
→ multiplayer

Agent
→ shared

Skills
→ shared

MCP
→ shared

Knowledge
→ shared

Models
→ centrally governed

Projects
→ collaborative

Automation
→ proactive
```

manteniendo ejecución local allí donde sea necesaria y ejecución server-side allí donde aporte disponibilidad y autonomía.

---

# 110. Resumen de arquitectura final

```text
                           ORGANIZATION
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
        CHATS                WORK ZONE              AGENTS
          │                     │                     │
 Humans + AI              Local execution       Persistent AI
 Channels                 Codex / Claude        OpenClaw
 Threads                  Git / Files           Automations
 AI Chats                 Multiplayer           Proactive msgs
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                            PROJECTS
                                │
                  ┌─────────────┼──────────────┐
                  │             │              │
                Skills         MCP         Knowledge
                  │             │              │
                  └─────────────┼──────────────┘
                                │
                         CONTROL PLANE
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
    Model Gateway          Device Relay          Audit/Policy
          │                     │
          │                     ▼
          │                Local Runtime
          │                     │
          │            ┌────────┼────────┐
          │            │        │        │
          │          Codex   Claude   OpenCode
          │
          ▼
   Provider Pools
 OpenAI / Anthropic / Others

                     SERVER AGENT PLANE
                             │
                          OpenClaw
                             │
                 Native Platform Channel
                             │
              Proactive + Reactive Messaging
```

---

**Fin del PRD v0.3 consolidado.**
