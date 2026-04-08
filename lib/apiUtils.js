import axios from "axios";

/**
 * Makes an authenticated API request.
 * @param {string} url - The API endpoint.
 * @param {object} auth - Authentication object { username, password }.
 * @param {object} options - Additional Axios options.
 * @returns {Promise<any>} - The API response.
 */
export async function makeApiRequest(url, auth, options = {}) {
  try {
    // Se método POST especificado, usar POST; caso contrário, usar GET
    const method = options.method || 'GET';
    const axiosConfig = {
      auth,
      ...options,
    };
    
    // Remover method das options do axios (não é um parâmetro válido)
    delete axiosConfig.method;
    
    let response;
    if (method === 'POST') {
      response = await axios.post(url, options.data || {}, axiosConfig);
    } else {
      response = await axios.get(url, axiosConfig);
    }
    return response.data;
  } catch (error) {
    const statusCode = error.response?.status;
    const errorData = error.response?.data;
    const errorMessage = errorData?.errorMessages?.join(', ') || errorData?.message || error.message;
    
    console.error(`❌ Erro na Requisição API (${statusCode || 'N/A'}): ${errorMessage}`);
    console.error(`   URL: ${url}`);
    if (options.params?.jql) {
      console.error(`   JQL: ${options.params.jql}`);
    }
    
    throw error;
  }
}
