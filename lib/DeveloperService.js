import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DeveloperService {
  constructor(developersPath = null) {
    if (developersPath) {
      this.developersPath = developersPath;
    } else {
      this.developersPath = path.join(__dirname, '..', 'developers.json');
    }
    this.cache = null;
  }

  /**
   * Carrega a lista de desenvolvedores do arquivo JSON
   */
  async loadDevelopers() {
    if (this.cache) {
      return this.cache;
    }

    try {
      const data = await fs.readFile(this.developersPath, 'utf8');
      this.cache = JSON.parse(data);
      return this.cache;
    } catch (error) {
      console.warn(`⚠️  Arquivo de desenvolvedores não encontrado (${this.developersPath}), usando lista vazia`);
      return { developers: {}, metadata: {} };
    }
  }

  /**
   * Limpa o cache para permitir recarregar de outro arquivo
   */
  clearCache() {
    this.cache = null;
  }

  /**
   * Define um novo caminho e limpa o cache
   */
  setDevelopersPath(newPath) {
    this.developersPath = newPath;
    this.clearCache();
  }

  /**
   * Busca desenvolvedor por email ou username
   */
  async findDeveloper(searchTerm) {
    const data = await this.loadDevelopers();
    const normalizedSearch = searchTerm.toLowerCase().trim();

    for (const role of Object.keys(data.developers)) {
      for (const dev of data.developers[role]) {
        if (dev.email.toLowerCase() === normalizedSearch || 
            dev.username.toLowerCase() === normalizedSearch ||
            dev.name.toLowerCase().includes(normalizedSearch)) {
          return {
            ...dev,
            roleCategory: role
          };
        }
      }
    }

    return null;
  }

  /**
   * Retorna lista de todos os desenvolvedores com filtro opcional por role
   */
  async getAllDevelopers(roleFilter = null) {
    const data = await this.loadDevelopers();
    const allDevs = [];

    for (const role of Object.keys(data.developers)) {
      if (!roleFilter || role === roleFilter) {
        for (const dev of data.developers[role]) {
          allDevs.push({
            ...dev,
            roleCategory: role
          });
        }
      }
    }

    return allDevs.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Retorna lista de emails para usar no filtro de performance
   */
  async getDeveloperEmails() {
    const developers = await this.getAllDevelopers();
    return developers.map(dev => dev.email);
  }

  /**
   * Retorna lista de usernames para usar no filtro de performance
   */
  async getDeveloperUsernames() {
    const developers = await this.getAllDevelopers();
    return developers.map(dev => dev.username);
  }

  /**
   * Filtra lista de members baseado na lista de desenvolvedores
   */
  async filterRealDevelopers(membersList) {
    const developers = await this.getAllDevelopers();
    const devEmails = new Set(developers.map(dev => dev.email.toLowerCase()));
    const devUsernames = new Set(developers.map(dev => dev.username.toLowerCase()));

    return membersList.filter(member => {
      const memberEmail = (member.email || '').toLowerCase();
      const memberName = (member.name || '').toLowerCase();
      const memberUsername = (member.username || member.displayName || '').toLowerCase();

      return devEmails.has(memberEmail) || 
             devUsernames.has(memberUsername) ||
             devUsernames.has(memberName);
    });
  }

  /**
   * Enriquece dados de member com informações do desenvolvedor
   */
  async enrichMemberData(member) {
    const searchTerms = [
      member.email,
      member.username,
      member.displayName,
      member.name
    ].filter(Boolean);

    for (const term of searchTerms) {
      const developer = await this.findDeveloper(term);
      if (developer) {
        return {
          ...member,
          developerInfo: developer,
          role: developer.role,
          roleCategory: developer.roleCategory
        };
      }
    }

    return member;
  }

  /**
   * Busca sugestões de desenvolvedores para autocomplete
   */
  async searchDeveloperSuggestions(partialName) {
    const developers = await this.getAllDevelopers();
    const normalized = partialName.toLowerCase();

    return developers
      .filter(dev => 
        dev.name.toLowerCase().includes(normalized) ||
        dev.email.toLowerCase().includes(normalized) ||
        dev.username.toLowerCase().includes(normalized)
      )
      .slice(0, 10) // Limitar a 10 sugestões
      .map(dev => ({
        display: `${dev.name} (${dev.role}) - ${dev.email}`,
        value: dev.email,
        developer: dev
      }));
  }

  /**
   * Retorna estatísticas dos desenvolvedores
   */
  async getDeveloperStats() {
    const data = await this.loadDevelopers();
    const stats = {
      total: 0,
      byRole: {}
    };

    for (const role of Object.keys(data.developers)) {
      const count = data.developers[role].length;
      stats.byRole[role] = count;
      stats.total += count;
    }

    return stats;
  }

  /**
   * Exibe menu completo de todos os colaboradores organizados por categoria
   */
  async displayAllDevelopersMenu() {
    const data = await this.loadDevelopers();
    const stats = await this.getDeveloperStats();

    console.log('👥 Lista Completa de Colaboradores');
    console.log('═'.repeat(60));
    console.log(`📊 Total: ${stats.total} desenvolvedores | Versão: ${data.metadata?.version || '1.0.0'}`);
    console.log(`📅 Atualizado: ${data.metadata?.lastUpdated || 'N/A'}\n`);

    const roleEmojis = {
      qa: '🧪',
      frontend: '💻', 
      backend: '⚙️',
      mobile: '📱',
      dados: '📊'
    };

    const roleNames = {
      qa: 'QA / Quality Assurance',
      frontend: 'Frontend Development',
      backend: 'Backend Development', 
      mobile: 'Mobile Development',
      dados: 'Dados / Data Science'
    };

    for (const [roleKey, developers] of Object.entries(data.developers)) {
      const emoji = roleEmojis[roleKey] || '👤';
      const roleName = roleNames[roleKey] || roleKey.charAt(0).toUpperCase() + roleKey.slice(1);
      
      console.log(`${emoji} ${roleName} (${developers.length} pessoas):`);
      console.log('─'.repeat(50));
      
      developers.forEach((dev, index) => {
        console.log(`   ${index + 1}. ${dev.name}`);
        console.log(`      📧 ${dev.email}`);
        console.log(`      👤 ${dev.username}\n`);
      });
    }

    console.log('💡 Para buscar um desenvolvedor específico, use a opção 5 do menu performance');
    console.log('💡 Para editar esta lista, modifique: developers.json (ou DEVELOPERS_JSON)\n');
  }
}

export default DeveloperService;
